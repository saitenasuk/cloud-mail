import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

//企业微信群机器人：text 类型为纯文本，内容上限 2048 字节
const WEBHOOK_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=';
const MESSAGE_LIMIT = 2048;
const SUBJECT_LIMIT = 200;
const TRUNCATED_SUFFIX = '...';
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

function oneLine(value) {
	return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function truncate(text, maxBytes) {
	const encoder = new TextEncoder();

	if (encoder.encode(text).length <= maxBytes) {
		return text;
	}

	if (maxBytes <= TRUNCATED_SUFFIX.length) {
		return TRUNCATED_SUFFIX.slice(0, maxBytes);
	}

	const limit = maxBytes - TRUNCATED_SUFFIX.length;
	let result = '';
	let bytes = 0;

	for (const char of text) {
		const charBytes = encoder.encode(char).length;
		if (bytes + charBytes > limit) {
			break;
		}
		result += char;
		bytes += charBytes;
	}

	return result + TRUNCATED_SUFFIX;
}

function formatTime(createTime, timeZone) {
	const time = dayjs.utc(createTime);

	if (!time.isValid()) {
		return oneLine(createTime);
	}

	try {
		return time.tz(timeZone || DEFAULT_TIME_ZONE).format('YYYY-MM-DD HH:mm:ss');
	} catch (e) {
		return time.tz(DEFAULT_TIME_ZONE).format('YYYY-MM-DD HH:mm:ss');
	}
}

const wecomService = {

	async sendEmail(c, emailRow, webhookUrl, timeZone) {

		const url = this.toWebhookUrl(webhookUrl);

		if (!url) {
			return;
		}

		const content = this.buildContent(emailRow, timeZone);

		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					msgtype: 'text',
					text: { content }
				})
			});

			if (!res.ok) {
				console.error(`企业微信推送失败 status: ${res.status} response: ${await res.text()}`);
				return;
			}

			//企业微信业务失败时 HTTP 状态码仍为 200，需要看 errcode
			const result = await res.json();
			if (result?.errcode !== 0) {
				console.error(`企业微信推送失败 errcode: ${result?.errcode} errmsg: ${result?.errmsg}`);
			}
		} catch (e) {
			console.error(`企业微信推送失败: ${e.message}`);
		}

	},

	toWebhookUrl(webhookUrl) {

		webhookUrl = (webhookUrl || '').trim();

		if (!webhookUrl) {
			return '';
		}

		if (/^https?:\/\//i.test(webhookUrl)) {
			return webhookUrl;
		}

		return WEBHOOK_URL + webhookUrl.replace(/^key=/i, '');
	},

	buildContent(emailRow, timeZone) {

		const subject = truncate(oneLine(emailRow.subject) || '(无主题)', SUBJECT_LIMIT);
		const sendEmail = oneLine(emailRow.sendEmail);
		const name = oneLine(emailRow.name);
		const from = name ? (sendEmail ? `${name} <${sendEmail}>` : name) : sendEmail;

		const lines = [
			`【新邮件】${subject}`,
			`发件人：${from}`,
			`收件人：${oneLine(emailRow.toEmail)}`,
			`收件时间：${formatTime(emailRow.createTime, timeZone)}`
		];

		if (emailRow.code) {
			lines.splice(1, 0, `验证码：${oneLine(emailRow.code)}`);
		}

		return truncate(lines.join('\n'), MESSAGE_LIMIT);
	}

};

export default wecomService;