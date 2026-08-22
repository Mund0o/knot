// Emoji.gg license normalization.
//
// The public catalog API reports licenses as numeric codes. The meaning of each
// code was verified against real public detail pages:
//   "0" -> Basic          (site default grant; NOT redistributable)
//   "1" -> CC BY 4.0      (attribution required)
//   "2" -> WTFPL          (public-domain-like; no attribution required)
//   ""  -> unknown        (treated as not redistributable)
//
// Rules mandated by the catalog policy:
//   * Never convert an unknown value into an allowed one.
//   * Missing license is never assumed to be WTFPL.
const LICENSES = {
  BASIC: 'Basic',
  CC_BY_4_0: 'CC-BY-4.0',
  WTFPL: 'WTFPL',
  STREAMER: 'Streamer License',
  UNKNOWN: 'Unknown',
};

function normalizeLicense(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return LICENSES.UNKNOWN;
  // "Basic" and "Basic with credits" are redistributable per operator policy
  // (free-platform usage grant); credits variants are satisfied by the
  // attribution view which always lists creator + source.
  if (/^(0|basic)( with credits)?$/i.test(value)) return LICENSES.BASIC;
  if (/^(1|cc[- ]?by[- ]?4(\.0)?|creative commons attribution 4\.0.*)$/i.test(value)) return LICENSES.CC_BY_4_0;
  if (/^(2|wtfpl|do what the fuck you want.*|wtf public license.*)$/i.test(value)) return LICENSES.WTFPL;
  if (/streamer/i.test(value)) return LICENSES.STREAMER;
  // Free-text values from future API versions: accept only exact well-known names.
  const lower = value.toLowerCase();
  if (lower === 'cc-by-4.0' || lower === 'cc by 4.0') return LICENSES.CC_BY_4_0;
  if (lower === 'wtfpl') return LICENSES.WTFPL;
  return LICENSES.UNKNOWN;
}

const REDISTRIBUTABLE = new Set([LICENSES.CC_BY_4_0, LICENSES.WTFPL, LICENSES.BASIC]);
const MIRRORABLE = raw => REDISTRIBUTABLE.has(normalizeLicense(raw));
function attributionRequired(license) { return normalizeLicense(license) === LICENSES.CC_BY_4_0; }
function rank(license) {
  switch (normalizeLicense(license)) {
    case LICENSES.WTFPL: return 0;
    case LICENSES.CC_BY_4_0: return 1;
    case LICENSES.BASIC: return 2;
    default: return Number.MAX_SAFE_INTEGER;
  }
}
module.exports = { LICENSES, normalizeLicense, MIRRORABLE, attributionRequired, rank };
