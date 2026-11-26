# sejl-sikkert-data

`npm run build-data` henter DMI-vind (HARMONIE) og DMI-strøm (DKSS) for danske farvande og skriver kompakte JSON-filer i `out/`.

Fliserne, omridset og gitteret står i `src/config.ts`: 20 fliser på ca. 100 km, der dækker Danmarks farvande. Hver flise bliver et 10×10-gitter pr. time. Den stærkeste vektor beholdes i hvert felt, og timerne er +0 til +48 i trin på 3 timer. Konverteringen er kopieret fra [sejl-sikkert-app](https://github.com/jsnielsendk/sejl-sikkert-app) ved commit `aa67b261981f151cc7869945ec0bcfb0f8917719`.

Kaldet til DMI sker serielt med pause og med højst tre forsøg ved 429 og 5xx. Der bruges ingen API-nøgle. `out/` er lokalt output og skal ikke committes. `manifest.json` skrives kun, når alle fliser er lykkedes. Mappen får også `index.html` med kreditering og en `.nojekyll`.

Tallene afrundes først, når flisen skrives: fart til 0,01 m/s, retning til 0,1° i intervallet [0, 360), og koordinater til 0,0001°. Den stærkeste vektor vælges stadig på fuld præcision. Formatversionen er 1.

Pausen mellem kald er 2 sekunder. Sæt `DMI_PAUSE_MS` til et højere millisekundtal, hvis Actions ofte får 429. Hæv ikke antallet af forsøg. Et `Retry-After` fra DMI følges, men et enkelt ventetidspunkt er højst 120 sekunder.

`src/app/checksums.json` har sha256 af appens originale filer ved `7dd41ec73ad5ed2e3b4738800a245dd2e37c890d` i `files`. `excerpts` er sha256 af kopierne i dette repo. Testen fejler, hvis en kopi ændres uden at `excerpts` opdateres. App-repoet er privat, så CI henter ikke kilderne og bruger ikke et token.

Workflowet `build-deploy` kører `47 */3 * * *` og backup-linjen `17 1-23/3 * * *`, plus `workflow_dispatch`. Kun en planlagt kørsel springer build og deploy over, og kun når manifestets alder er fra 0 til under to timer. `workflow_dispatch` og `push` bygger altid. Et tidsstempel i fremtiden bygger også, med warning `MANIFEST_FUTURE`. Er manifestet over seks timer, skrives `MANIFEST_STALE`, og der bygges alligevel. En fejlet build deployer ikke, så den sidste gode udgave bliver liggende.

`keepalive.yml` committer `keepalive.txt` den 1. i måneden. GitHub slår planlagte workflows fra efter 60 dage uden aktivitet i repoet, og den månedlige commit holder dem i gang. `contents: write` gælder kun det job.

## Licens

Koden i dette repo er MIT. Se [LICENSE](LICENSE).

Vejrdataene er bearbejdet DMI-data og er under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/):

Kilde: DMI (Danmarks Meteorologiske Institut), bearbejdet.
