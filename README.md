# sejl-sikkert-data

`npm run build-data` henter DMI-vind (HARMONIE) og DMI-strøm (DKSS) for danske farvande og skriver kompakte JSON-filer i `out/`.

Fliserne, omridset og gitteret står i `src/config.ts`: 20 fliser på ca. 100 km, der dækker Danmarks farvande. Hver flise bliver et 10×10-gitter pr. time. Den stærkeste vektor beholdes i hvert felt, og timerne er +0 til +48 i trin på 3 timer. Konverteringen er kopieret fra [sejl-sikkert-app](https://github.com/jsnielsendk/sejl-sikkert-app) ved commit `aa67b261981f151cc7869945ec0bcfb0f8917719`.

Kaldet til DMI sker serielt med pause og med højst tre forsøg ved 429 og 5xx. Der bruges ingen API-nøgle. `out/` er lokalt output og skal ikke committes. `manifest.json` skrives kun, når alle fliser er lykkedes.

## Licens

Koden i dette repo er MIT. Se [LICENSE](LICENSE).

Vejrdataene er bearbejdet DMI-data og er under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/):

Kilde: DMI (Danmarks Meteorologiske Institut), bearbejdet.
