'use strict';

const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAJ53dxZeJygsorP/NL/dnWscJUFXxafuucufvPImHpPE=
-----END PUBLIC KEY-----`;

const SIGNED_MANIFEST_FIELDS = [
  'version', 'notes', 'linuxUrl', 'linuxSha256', 'linuxAppImageUrl',
  'linuxAppImageSha256', 'winUrl', 'winSha256',
];

function canonicalManifestPayload(manifest) {
  const payload = {};
  for (const field of SIGNED_MANIFEST_FIELDS) payload[field] = typeof manifest?.[field] === 'string' ? manifest[field] : '';
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

module.exports = { UPDATE_PUBLIC_KEY, SIGNED_MANIFEST_FIELDS, canonicalManifestPayload };
