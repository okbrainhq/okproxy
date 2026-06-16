const { domainToASCII } = require('node:url');

const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function normalizeDomain(input) {
  if (typeof input !== 'string') return null;
  let domain = input.trim().toLowerCase();
  if (!domain) return null;
  if (domain.endsWith('.')) domain = domain.slice(0, -1);
  if (!domain || domain.includes('*')) return null;

  const ascii = domainToASCII(domain);
  if (!ascii) return null;
  domain = ascii.toLowerCase();

  if (domain.length > 253) return null;
  const labels = domain.split('.');
  if (labels.length < 2) return null;
  if (labels.some(label => !label || !DOMAIN_LABEL_RE.test(label))) return null;
  return domain;
}

function normalizeDomains(domains) {
  const seen = new Set();
  const result = [];
  for (const value of domains || []) {
    const domain = normalizeDomain(value);
    if (!domain) throw new Error(`Invalid domain: ${value}`);
    if (seen.has(domain)) throw new Error(`Duplicate domain: ${domain}`);
    seen.add(domain);
    result.push(domain);
  }
  return result;
}

function normalizeHost(hostHeader) {
  if (typeof hostHeader !== 'string') return null;
  let host = hostHeader.trim();
  if (!host) return null;

  // Reject IPv6 literals for cert-bound public domain routing in v1.
  if (host.startsWith('[')) return null;

  const colon = host.lastIndexOf(':');
  if (colon !== -1) {
    const port = host.slice(colon + 1);
    if (/^\d+$/.test(port)) host = host.slice(0, colon);
  }

  return normalizeDomain(host);
}

function extractAuthorizedDomains(cert) {
  const san = cert && typeof cert.subjectaltname === 'string' ? cert.subjectaltname : '';
  if (!san) return [];

  const domains = [];
  for (const part of san.split(/,\s*/)) {
    const match = part.match(/^DNS:(.+)$/i);
    if (!match) continue;
    const domain = normalizeDomain(match[1]);
    if (domain && !domains.includes(domain)) domains.push(domain);
  }
  return domains;
}

module.exports = {
  normalizeDomain,
  normalizeDomains,
  normalizeHost,
  extractAuthorizedDomains
};
