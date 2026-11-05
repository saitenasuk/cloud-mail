import { parseHTML } from 'linkedom';
import orm from '../entity/orm';
import email from '../entity/email';
import { and, eq } from 'drizzle-orm';
import { isDel } from '../const/entity-const';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';
import userContext from '../security/user-context';
import KvConst from '../const/kv-const';
import settingService from './setting-service';

//目标语言固定为简体中文
const TARGET_LANG = 'zh-CN';

//Google 网页翻译组件使用的接口，HTML 原样保留，一次可发整封邮件
const HTML_ENDPOINT = 'https://translate-pa.googleapis.com/v1/translateHtml';
//官方 Cloud Translation v2，需要自己申请 key，作为备用引擎
const V2_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';

//免费的旧接口，不需要 key，作为没配置 key 时以及最后的兜底
const LEGACY_ENDPOINTS = [
	{ url: `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${TARGET_LANG}`, type: 'multi' },
	{ url: `https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&tl=${TARGET_LANG}`, type: 'multi' }
];

const CHUNK_LIMIT = 20000;
//旧接口单条上限小得多，单独限制
const LEGACY_CHUNK_LIMIT = 4000;
const MAX_CHUNKS = 6;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS = [800, 2500];
const MAX_RETRY_AFTER = 5000;
const REQUEST_TIMEOUT = 15000;
const CACHE_TTL = 60 * 60 * 24 * 7;
const DOMAIN_TOKEN = '__tr_domain__';
//中文占比超过该值就认为已经是目标语言，不必请求
const CHINESE_RATIO = 0.5;
const MIN_LENGTH_FOR_LANGUAGE_CHECK = 30;

const translateService = {

	async translateEmail(c, emailId) {

		const user = userContext.getUser(c);
		const emailRow = await orm(c).select().from(email).where(and(
			eq(email.emailId, emailId),
			eq(email.isDel, isDel.NORMAL)
		)).get();

		if (!emailRow) {
			throw new BizError(t('notExistEmail'));
		}

		//自己的邮件，或者拥有全部邮件查看权限
		const permKeys = user?.permKeys || [];
		const canViewAll = permKeys.includes('*') || permKeys.includes('all-email:query');

		if (emailRow.userId !== user?.userId && !canViewAll) {
			throw new BizError(t('unauthorized'), 403);
		}

		const cacheKey = KvConst.TRANSLATE + emailId;

		try {
			const cached = await c.env.kv.get(cacheKey, { type: 'json' });
			if (cached) {
				return cached;
			}
		} catch (e) {
			console.error('读取翻译缓存失败:', e.message);
		}

		if (!emailRow.content && !emailRow.text) {
			throw new BizError(t('emptyTranslateContent'));
		}

		const engines = await this.resolveEngines(c);
		const translated = await this.translateRow(emailRow, engines);

		if (!translated.skipped) {
			try {
				await c.env.kv.put(cacheKey, JSON.stringify(translated), { expirationTtl: CACHE_TTL });
			} catch (e) {
				console.error('写入翻译缓存失败:', e.message);
			}
		}

		return translated;
	},

	//按优先级排列可用引擎：管理员填的 key 先试，内置公开 key 兜底，旧接口最后
	async resolveEngines(c) {

		let translateKey = '';
		try {
			translateKey = ((await settingService.query(c)).translateKey || '').trim();
		} catch (e) {
			console.error('读取翻译 key 失败:', e.message);
		}

		const engines = [];

		if (translateKey) {
			engines.push({ type: 'html', key: translateKey });
			engines.push({ type: 'v2', key: translateKey });
		}

		engines.push({ type: 'legacy' });

		return engines;
	},

	//用一条短句真实调用一次，确认 key 是否可用；留空则测试免费接口
	async testKey(c, key) {

		const translateKey = String(key || '').trim();
		const engines = translateKey
			? [{ type: 'html', key: translateKey }, { type: 'v2', key: translateKey }]
			: [{ type: 'legacy' }];

		const errors = [];

		for (const engine of engines) {
			try {
				const sample = await this.callEngine(engine, 'Hello');
				if (!sample || !sample.trim()) {
					errors.push(`${engine.type}: 返回为空`);
					continue;
				}
				return { ok: true, engine: engine.type, builtin: !translateKey, sample: sample.trim() };
			} catch (e) {
				errors.push(`${engine.type}: ${e.message}`);
			}
		}

		return { ok: false, engine: '', builtin: !translateKey, sample: '', error: errors.join(' | ') };
	},

	async translateRow(emailRow, engines) {

		const subjectText = this.oneLine(emailRow.subject);

		//正文优先 HTML，没有 HTML 才用纯文本
		const bodyText = emailRow.content || emailRow.text || '';
		if (this.isAlreadyTargetLanguage(bodyText)) {
			return { subject: '', content: '', text: '', skipped: true };
		}

		const subject = subjectText ? await this.translateChunk(subjectText, engines) : '';

		if (emailRow.content) {
			const content = await this.translateHtml(emailRow.content, engines);

			//整封译文和原文没有差别，说明本来就是中文
			if (this.sameText(content, emailRow.content)) {
				return { subject: '', content: '', text: '', skipped: true };
			}

			return {
				subject: this.sameText(subject, subjectText) ? '' : subject,
				content,
				text: '',
				skipped: false
			};
		}

		const text = await this.translatePlain(emailRow.text || '', engines);

		if (this.sameText(text, emailRow.text)) {
			return { subject: '', content: '', text: '', skipped: true };
		}

		return {
			subject: this.sameText(subject, subjectText) ? '' : subject,
			content: '',
			text,
			skipped: false
		};
	},

	async translateHtml(html, engines) {

		const { prepared, assets, blocks } = this.prepareHtml(html);
		const chunks = this.splitChunks(prepared).slice(0, MAX_CHUNKS);

		const translated = [];
		for (const chunk of chunks) {
			translated.push(await this.translateChunk(chunk, engines));
		}

		return this.restoreAssets(translated.join(''), assets, blocks);
	},

	//纯文本按行包成 <p> 再翻，换行不会丢；旧接口能直接处理换行，优先用它
	async translatePlain(text, engines) {

		const legacy = engines.find(engine => engine.type === 'legacy');

		if (legacy) {
			try {
				return (await this.translateChunksLegacy(text, legacy)).join('');
			} catch (e) {
				console.error('旧接口翻译纯文本失败，改用 HTML 引擎:', e.message);
			}
		}

		const htmlEngines = engines.filter(engine => engine.type !== 'legacy');
		const html = this.textToHtml(text);
		const translated = await this.translateChunk(html, htmlEngines);

		return this.htmlToText(translated);
	},

	async translateChunk(text, engines) {

		if (!text || !text.trim()) {
			return text;
		}

		let lastError;

		for (const engine of engines) {
			try {
				return await this.withRetry(() => this.callEngine(engine, text));
			} catch (e) {
				lastError = e;
				console.error(`翻译引擎 ${engine.type} 失败: ${e.message}`);
			}
		}

		throw new BizError(lastError?.authFailed ? t('translateKeyInvalid') : t('translateFailed'));
	},

	async withRetry(fn) {

		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			try {
				return await fn();
			} catch (e) {
				if (!e.retryable || attempt === MAX_ATTEMPTS - 1) {
					throw e;
				}
				const delay = e.retryAfterMs ?? RETRY_DELAYS[attempt] ?? 2500;
				await new Promise(resolve => setTimeout(resolve, delay));
			}
		}
	},

	callEngine(engine, text) {
		if (engine.type === 'html') {
			return this.callHtmlEngine(engine.key, text);
		}
		if (engine.type === 'v2') {
			return this.callV2Engine(engine.key, text);
		}
		return this.translateChunksLegacy(text).then(chunks => chunks.join(''));
	},

	async callHtmlEngine(key, text) {

		const res = await fetch(HTML_ENDPOINT, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json+protobuf',
				'X-Goog-API-Key': key
			},
			body: JSON.stringify([[[text], 'auto', TARGET_LANG], 'wt_lib']),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT)
		});

		if (!res.ok) {
			throw await this.toRequestError(res);
		}

		const data = await res.json();

		if (!Array.isArray(data) || !Array.isArray(data[0]) || typeof data[0][0] !== 'string') {
			throw this.error('响应格式异常', { retryable: false });
		}

		return data[0][0];
	},

	async callV2Engine(key, text) {

		const body = new URLSearchParams();
		body.append('q', text);
		body.append('target', TARGET_LANG);
		body.append('format', 'html');

		const res = await fetch(`${V2_ENDPOINT}?key=${encodeURIComponent(key)}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: body.toString(),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT)
		});

		if (!res.ok) {
			throw await this.toRequestError(res);
		}

		const data = await res.json();
		const translations = data?.data?.translations;

		if (!Array.isArray(translations) || typeof translations[0]?.translatedText !== 'string') {
			throw this.error('响应格式异常', { retryable: false });
		}

		return translations.map(item => item.translatedText).join('');
	},

	//旧接口支持一次多条，保持原有分批逻辑
	async translateChunksLegacy(text) {
		let lastError;

		for (const endpoint of LEGACY_ENDPOINTS) {
			try {
				const chunks = this.splitChunks(text, LEGACY_CHUNK_LIMIT).slice(0, MAX_CHUNKS);
				return await this.withRetry(() => this.callLegacyEndpoint(endpoint, chunks));
			} catch (e) {
				lastError = e;
			}
		}

		throw lastError;
	},

	async callLegacyEndpoint(endpoint, texts) {

		const body = new URLSearchParams();
		texts.forEach(text => body.append('q', text));

		const res = await fetch(endpoint.url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: body.toString(),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT)
		});

		if (!res.ok) {
			throw await this.toRequestError(res);
		}

		const data = await res.json();

		if (!Array.isArray(data) || data.length !== texts.length) {
			throw this.error('响应格式异常', { retryable: false });
		}

		return data.map(item => (Array.isArray(item) ? String(item[0] ?? '') : String(item ?? '')));
	},

	async toRequestError(res) {

		const status = res.status;
		let message = `status ${status}`;

		try {
			message += ` ${(await res.text()).slice(0, 200)}`;
		} catch (e) {
			//读不到响应体不影响判断
		}

		//key 无效或没有该接口权限，换下一个引擎，不重试
		const authFailed = status === 400 || status === 401 || status === 403;
		const retryable = status === 429 || status >= 500;

		return this.error(message, {
			status,
			retryable,
			authFailed,
			retryAfterMs: retryable ? this.retryAfterMs(res) : undefined
		});
	},

	retryAfterMs(res) {
		const header = res.headers?.get?.('retry-after');
		if (!header) {
			return undefined;
		}
		const seconds = Number(header);
		if (!isNaN(seconds)) {
			return Math.min(seconds * 1000, MAX_RETRY_AFTER);
		}
		const date = Date.parse(header);
		if (!isNaN(date)) {
			return Math.max(0, Math.min(date - Date.now(), MAX_RETRY_AFTER));
		}
		return undefined;
	},

	error(message, meta = {}) {
		const error = new Error(message);
		Object.assign(error, meta);
		return error;
	},

	//译文和原文没有实质差别，说明本来就是目标语言
	sameText(translated, source) {
		return this.normalize(translated) === this.normalize(source);
	},

	normalize(text) {
		return String(text || '')
			.replace(/<[^>]*>/g, ' ')
			.replace(/[\u200B-\u200D\uFEFF]/g, '')
			.replace(/[\s\u00A0]+/g, '')
			.toLowerCase();
	},

	isAlreadyTargetLanguage(text) {

		const plain = this.plainText(text);

		if (plain.length < MIN_LENGTH_FOR_LANGUAGE_CHECK) {
			return false;
		}

		const han = (plain.match(/[\u4E00-\u9FFF]/g) || []).length;
		const letters = (plain.match(/[A-Za-z\u4E00-\u9FFF]/g) || []).length;

		return letters > 0 && han / letters >= CHINESE_RATIO;
	},

	plainText(text) {
		return String(text || '')
			.replace(/<style[\s\S]*?<\/style>/gi, ' ')
			.replace(/<script[\s\S]*?<\/script>/gi, ' ')
			.replace(/<[^>]*>/g, ' ');
	},

	textToHtml(text) {
		return String(text || '')
			.split(/\r?\n/)
			.map(line => `<p>${this.escapeHtml(line)}</p>`)
			.join('');
	},

	htmlToText(html) {
		const withBreaks = String(html || '')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/p>/gi, '\n')
			.replace(/<[^>]*>/g, '');
		return this.decodeEntities(withBreaks).replace(/\n+$/, '');
	},

	escapeHtml(text) {
		return String(text || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	},

	decodeEntities(html) {
		try {
			//linkedom 需要完整文档结构才能解析 <body>
			const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
			return document.body?.textContent || '';
		} catch (e) {
			return html;
		}
	},

	//样式、脚本、注释不参与翻译
	prepareHtml(html) {

		let prepared = html
			.replace(/<style[\s\S]*?<\/style>/gi, '')
			.replace(/<script[\s\S]*?<\/script>/gi, '')
			.replace(/<!--[\s\S]*?-->/g, '');

		//data URI 会撑大请求体，先占位，翻译后原样还原
		const assets = [];
		prepared = prepared.replace(/(src|background)\s*=\s*(["'])(data:[^"']*)\2/gi, (match, attr, quote, value) => {
			assets.push(value);
			return `${attr}=${quote}${this.assetToken(assets.length - 1)}${quote}`;
		});

		//<pre> 里换行是排版语义，且多半是代码，整块占位不翻译
		const blocks = [];
		prepared = prepared.replace(/(<pre\b[^>]*>)([\s\S]*?)(<\/pre>)/gi, (match, open, inner, close) => {
			blocks.push(inner);
			return `${open}${this.blockToken(blocks.length - 1)}${close}`;
		});

		//正文图片地址里的域名占位符不能被翻译掉
		prepared = prepared.replace(/\{\{domain\}\}/g, DOMAIN_TOKEN);

		return { prepared, assets, blocks };
	},

	restoreAssets(html, assets, blocks = []) {
		html = html.replace(/__tr_asset_(\d+)__/g, (match, index) => assets[Number(index)] ?? match);
		//翻译引擎会在占位符两侧补空格，<pre> 里必须去掉，否则代码首行会多一个空格
		html = html.replace(/(<pre\b[^>]*>)\s*__tr_block_(\d+)__\s*(<\/pre>)/gi,
			(match, open, index, close) => `${open}${blocks[Number(index)] ?? ''}${close}`);
		html = html.replace(/__tr_block_(\d+)__/g, (match, index) => blocks[Number(index)] ?? match);
		return html.replaceAll(DOMAIN_TOKEN, '{{domain}}');
	},

	assetToken(index) {
		return `__tr_asset_${index}__`;
	},

	blockToken(index) {
		return `__tr_block_${index}__`;
	},

	//按标签结尾切分，保证片段拼接后结构完整
	splitChunks(text, limit = CHUNK_LIMIT) {

		let rest = text || '';
		const chunks = [];

		while (rest.length > limit) {
			let cut = rest.lastIndexOf('>', limit);
			if (cut < limit / 2) {
				cut = rest.lastIndexOf(' ', limit);
			}
			if (cut <= 0) {
				cut = limit - 1;
			}
			chunks.push(rest.slice(0, cut + 1));
			rest = rest.slice(cut + 1);
		}

		if (rest) {
			chunks.push(rest);
		}

		return chunks.length ? chunks : [''];
	},

	oneLine(value) {
		return String(value || '').replace(/[\r\n]+/g, ' ').trim();
	}

};

export default translateService;