import emailUtils from './email-utils';

export function getR2Domain(email) {
	return `flowmails-r2.${emailUtils.getDomain(email)}`;
}
