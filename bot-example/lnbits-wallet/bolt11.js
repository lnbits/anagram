// Reads a BOLT11 invoice: amount, expiry, payment hash, description. The checksum is verified.
// The signature is checked only when the invoice names its destination, so that a name shown to
// the person is one the invoice was signed by. Otherwise finding who signed it would need key
// recovery, which is left to the wallet that pays. Either way this is for showing the person what
// they are about to pay and applying limits; the wallet checks everything again.
import { createPublicKey, ECDH, verify } from 'node:crypto';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const VALUES = new Map([...CHARSET].map((c, i) => [c, i]));
const MAX_LENGTH = 4096;
const SIGNATURE_WORDS = 104;
// Millisatoshis per unit of each amount suffix (1 BTC = 10^11 msat). A pico-bitcoin is a tenth
// of a millisatoshi, so it needs a whole number of tens.
const MSAT_PER = { m: 100000000n, u: 100000n, n: 100n };
const DEFAULT_EXPIRY = 3600;

export class InvoiceError extends Error {
  constructor(code) {
    super(`Invalid invoice (${code}).`);
    this.code = code;
  }
}

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let check = 1;
  for (const value of values) {
    const top = check >> 25;
    check = ((check & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) check ^= GEN[i];
  }
  return check;
}
export const hrpValues = (hrp) => [
  ...[...hrp].map((c) => c.charCodeAt(0) >> 5),
  0,
  ...[...hrp].map((c) => c.charCodeAt(0) & 31),
];
export const checksumOk = (hrp, words) => polymod([...hrpValues(hrp), ...words]) === 1;

const number = (words) => words.reduce((total, word) => total * 32 + word, 0);
function toBytes(words) {
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const word of words) {
    value = (value << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 255);
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(bytes);
}

// Whether the invoice's signature is by this node key (33 bytes, compressed).
function signedBy(hrp, words, signature, node) {
  try {
    const point = ECDH.convertKey(node, 'secp256k1', undefined, undefined, 'uncompressed');
    const key = createPublicKey({
      format: 'jwk',
      key: {
        kty: 'EC',
        crv: 'secp256k1',
        x: Buffer.from(point.subarray(1, 33)).toString('base64url'),
        y: Buffer.from(point.subarray(33, 65)).toString('base64url'),
      },
    });
    // The data words as bytes, padded with zero bits; the signature is over its SHA-256.
    const bytes = toBytes([...words, 0, 0]).subarray(0, Math.ceil((words.length * 5) / 8));
    const message = Buffer.concat([Buffer.from(hrp), bytes]);
    return verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, signature.subarray(0, 64));
  } catch {
    return false;
  }
}

// Throws InvoiceError. networks: the prefixes accepted ('bc' is Bitcoin mainnet).
export function decodeInvoice(text, { networks = ['bc'] } = {}) {
  const written = String(text ?? '')
    .trim()
    .replace(/^lightning:/i, '');
  // Bech32 is all one case. Mixed case is not an invoice.
  if (written !== written.toLowerCase() && written !== written.toUpperCase())
    throw new InvoiceError('format');
  const invoice = written.toLowerCase();
  if (!invoice || invoice.length > MAX_LENGTH) throw new InvoiceError('format');
  const split = invoice.lastIndexOf('1');
  if (split < 3) throw new InvoiceError('format');
  const hrp = invoice.slice(0, split);
  const match = /^ln(bcrt|bc|tbs|tb)(?:([1-9][0-9]*)([munp])?)?$/.exec(hrp);
  if (!match) throw new InvoiceError('format');
  const words = [...invoice.slice(split + 1)].map((c) => VALUES.get(c));
  if (words.some((w) => w === undefined) || words.length < 7 + SIGNATURE_WORDS + 6)
    throw new InvoiceError('format');
  if (!checksumOk(hrp, words)) throw new InvoiceError('checksum');
  const [, network, digits, unit] = match;
  if (!networks.includes(network)) throw new InvoiceError('network');
  if (!digits) throw new InvoiceError('no_amount');
  const units = BigInt(digits);
  if (unit === 'p' && units % 10n) throw new InvoiceError('format');
  const msatBig = unit === 'p' ? units / 10n : units * (unit ? MSAT_PER[unit] : 100000000000n);
  if (msatBig <= 0n || msatBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new InvoiceError('amount');
  const data = words.slice(0, -6);
  const timestamp = number(data.slice(0, 7));
  const end = data.length - SIGNATURE_WORDS;
  let expiry = DEFAULT_EXPIRY;
  let paymentHash;
  let description = '';
  let destination;
  const seen = new Set();
  for (let at = 7; at < end;) {
    if (at + 3 > end) throw new InvoiceError('format');
    const type = data[at];
    const length = data[at + 1] * 32 + data[at + 2];
    const field = data.slice(at + 3, at + 3 + length);
    if (at + 3 + length > end) throw new InvoiceError('format');
    // Wallets may read a repeated field differently from this: such an invoice is refused, so
    // that what is shown is what gets paid.
    if ([1, 6, 13, 19].includes(type)) {
      if (seen.has(type)) throw new InvoiceError('format');
      seen.add(type);
    }
    if (type === 1 && length === 52) paymentHash = toBytes(field).toString('hex');
    if (type === 6) {
      if (length > 7) throw new InvoiceError('format');
      expiry = number(field);
    }
    if (type === 13) description = toBytes(field).toString('utf8');
    if (type === 19) {
      if (length !== 53) throw new InvoiceError('format');
      destination = toBytes(field).subarray(0, 33);
    }
    at += 3 + length;
  }
  if (!/^[a-f0-9]{64}$/.test(paymentHash ?? '')) throw new InvoiceError('format');
  if (destination && !signedBy(hrp, data.slice(0, end), toBytes(data.slice(end)), destination))
    throw new InvoiceError('signature');
  return {
    invoice,
    network,
    amountMsat: Number(msatBig),
    timestamp,
    expiresAt: timestamp + expiry,
    paymentHash,
    description,
    ...(destination ? { destination: destination.toString('hex') } : {}),
  };
}
