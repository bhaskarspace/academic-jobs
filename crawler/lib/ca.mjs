// Extra CA certificates for hosts that send incomplete chains (UNABLE_TO_VERIFY_LEAF_SIGNATURE).
// Every config/ca/*.pem is added to Node's default trust store, never in place of it. These are
// public intermediates (and cross-signs) only; see config/ca/README.md. Never use `tls: insecure`.
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../../config/ca/', import.meta.url);
let loaded = null;

export function loadExtraCAs() {
  if (loaded) return loaded;
  const files = readdirSync(dir).filter((f) => f.endsWith('.pem')).sort();
  const pems = files.flatMap((f) => readFileSync(new URL(f, dir), 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []);
  if (typeof tls.setDefaultCACertificates === 'function') {
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...pems]);
    loaded = { files, applied: true };
  } else {
    // Node < 22.19: fall back to NODE_EXTRA_CA_CERTS=config/ca/bundle (set at process start).
    loaded = { files, applied: false };
    process.emitWarning(`tls.setDefaultCACertificates is missing in Node ${process.version}: config/ca/ not applied`);
  }
  return loaded;
}

/** Expiry of every certificate in config/ca/, for the health report. */
export function caExpiries(now = new Date()) {
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.pem')).sort()) {
    const pems = readFileSync(new URL(file, dir), 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    for (const pem of pems) {
      const c = new X509Certificate(pem);
      const notAfter = new Date(c.validTo).toISOString();
      out.push({ file, subject: c.subject.split('\n').find((l) => l.startsWith('CN='))?.slice(3) ?? c.subject, notAfter, daysLeft: Math.floor((Date.parse(notAfter) - now) / 86_400_000) });
    }
  }
  return out;
}
