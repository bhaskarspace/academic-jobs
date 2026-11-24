# Extra CA certificates

Some hosts send an incomplete certificate chain, so Node fails with
`UNABLE_TO_VERIFY_LEAF_SIGNATURE` or `UNABLE_TO_GET_ISSUER_CERT` (browsers and curl fill the gap
from their own caches). `crawler/lib/ca.mjs` adds every `*.pem` here to Node's default trust
store, alongside the default roots rather than replacing them. Only public intermediates and
cross-signs belong here, each downloaded from the issuing CA.

| File | Certificate | Issuer | Expires | Source | Needed by |
|---|---|---|---|---|---|
| letsencrypt-yr1.pem | Let's Encrypt YR1 | ISRG Root YR | 2028-09-02 | http://yr1.i.lencr.org/ (AIA) | www.hri.res.in |
| letsencrypt-root-yr-by-x1.pem | ISRG Root YR (cross-sign) | ISRG Root X1 | 2032-09-02 | https://letsencrypt.org/certs/gen-y/root-yr-by-x1.pem | www.hri.res.in (Root YR is not yet in trust stores) |
| globalsign-gcc-r46-alphassl-2025.pem | GlobalSign GCC R46 AlphaSSL CA 2025 | GlobalSign Root R46 | 2029-06-23 | http://secure.globalsign.com/cacert/gsgccr46alphasslca2025.crt (AIA) | www.aries.res.in (the server sends the R6 AlphaSSL intermediate instead) |
| sectigo-dv-r36.pem | Sectigo Public Server Authentication CA DV R36 | Sectigo Root R46 | 2036-03-21 | http://crt.sectigo.com/SectigoPublicServerAuthenticationCADVR36.crt (AIA) | www.ipr.res.in |

To add one: `openssl s_client -connect HOST:443 -servername HOST </dev/null | openssl x509 -noout -issuer -ext authorityInfoAccess`,
download the "CA Issuers" URL, convert it with `openssl x509 -inform DER -in X.crt -out NAME.pem`, and add a row here.
