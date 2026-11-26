# sejl-sikkert-data

`npm run build-data` henter DMI-vind (HARMONIE) og DMI-strøm (DKSS) for danske farvande og skriver kompakte JSON-filer i `out/`.

Fliserne, omridset og gitteret står i `src/config.ts`: 20 fliser på ca. 100 km, der dækker Danmarks farvande. Hver flise bliver et 10×10-gitter pr. time. Den stærkeste vektor beholdes i hvert felt, og timerne er +0 til +48 i trin på 3 timer. Konverteringen er kopieret fra [sejl-sikkert-app](https://github.com/jsnielsendk/sejl-sikkert-app) ved commit `aa67b261981f151cc7869945ec0bcfb0f8917719`.

Kaldet til DMI sker serielt med pause og med højst tre forsøg ved 429 og 5xx. Der bruges ingen API-nøgle. `out/` er lokalt output og skal ikke committes. `manifest.json` skrives kun, når alle fliser er lykkedes. Mappen får også `index.html` med kreditering og en `.nojekyll`.

Tallene afrundes først, når flisen skrives: vindstyrke rundes op til hele m/s med Math.ceil, fordi appens pilegrænse på 2,5 kn ikke er et helt m/s. Strømstyrke bliver 0,01 m/s, retning hele grader i [0, 360), og koordinater 0,0001°. 359,6° skrives som 0, ikke 360. Den stærkeste vektor vælges stadig på fuld præcision. Formatversionen er 1. Er fart, retning eller en koordinat ikke et endeligt tal, kaster skrivningen, buildet fejler, og deploy kører ikke.

Pausen mellem kald er 2 sekunder. Sæt `DMI_PAUSE_MS` til et højere millisekundtal, hvis Actions ofte får 429. Hæv ikke antallet af forsøg. Et `Retry-After` fra DMI følges, men et enkelt ventetidspunkt er højst 120 sekunder.

`src/app/checksums.json` har sha256 af appens originale filer ved `7dd41ec73ad5ed2e3b4738800a245dd2e37c890d` i `files`. `excerpts` er sha256 af kopierne i dette repo. Testen fejler, hvis en kopi ændres uden at `excerpts` opdateres. App-repoet er privat, så CI henter ikke kilderne og bruger ikke et token.

Workflowet `build-deploy` kører `47 */3 * * *` og backup-linjen `17 1-23/3 * * *`, plus `workflow_dispatch`, et push til `main` der kun ændrer `trigger/build.txt`, og `issues` med `types: [opened]`. Et issue starter build-jobbet kun når titlen er `build`, og forfatteren er `jsnielsendk` eller `OWNER`. Andre issues springer jobbet over og rører hverken DMI eller Pages. `issues`-eventet kører workflow-filen fra default-branchen `main`. Miljøet `github-pages` tillader kun `main`, så deploy fra det event bliver accepteret. Når issuet er et rigtigt build-kald, lukker et separat job det bagefter og skriver `built`, `skipped` eller `failed` plus run-URL. Det job har `issues: write` og kører med `if: always()` efter build og deploy. `force=true` gælder kun `workflow_dispatch`.

Før build sammenlignes DMI's seneste modelkørsel med manifestets `modelRuns`. Instans-id'er i fremtiden og ældre end 24 timer ignoreres, samme filter som `pickModelRun`. Der bygges, hvis mindst én kørsel er nyere, også når den anden model ikke svarer. Den manglende model logges som warning. Svarer ingen model med en nyere kørsel, skrives en advarsel, og der bygges kun når alderen er mindst 2 timer. Der bygges også, hvis manifestet er mindst 12 timer gammelt, hvis det ikke kan læses, eller hvis tidsstemplet ligger i fremtiden (`MANIFEST_FUTURE`). Samme kørsel og et yngre manifest springes over. Over seks timer skrives `MANIFEST_STALE`. Checkout er `ref: main`, så trigger-committen ikke kan skifte koden. Fejler selve datahentningen for en model, fejler buildet, deploy kører ikke, og den sidste gode Pages-udgave bliver liggende. Deploy-jobbet kræver `needs.build.result == 'success'`.

En branch som `trigger/build` kan ikke bruges. Miljøet `github-pages` tillader kun branchen `main`, og et push kører workflow-filen fra det commit der pushes. En sidebranch kunne derfor både blive afvist ved deploy og køre en anden workflow-fil. Ulempen ved filen på `main` er, at hvert kald er et commit på `main`, at branch protection kan blokere det, og at merge af det commit der tilføjer filen selv starter ét build.

## CoS-kald

Cursor-agenten har `contents:write` og ikke `actions:write`. `workflow_dispatch` svarer derfor 403. Kaldet der starter buildet er opdatering af triggerfilen på `main`:

```text
create_or_update_file
  owner: jsnielsendk
  repo: sejl-sikkert-data
  branch: main
  path: trigger/build.txt
  message: trigger: build DMI tiles
  content: <ny UTC-tidsstempel-linje, fx 2026-11-26T18:00:00Z>
  sha: <blob-sha for den nuværende fil; påkrævet når filen findes>
```

`sha` hentes med GET `https://api.github.com/repos/jsnielsendk/sejl-sikkert-data/contents/trigger/build.txt?ref=main` (feltet `sha`). Uden `sha` afviser GitHub opdateringen. Indholdet skal være nyt, ellers er der intet commit og intet push.

## Seneste modelkørsel

Billigste metadata-kald er instances-listen. Samlingens metadata har forecast-udstrækning, ikke modelkørsel-id. `limit=1` gør ikke dokumentet mindre. Målt 2026-11-26: HARMONIE 320372 bytes, DKSS NSBS 190781 bytes.

- Vind: `GET https://opendataapi.dmi.dk/v1/forecastedr/collections/harmonie_dini_sf/instances`
- Strøm: `GET https://opendataapi.dmi.dk/v1/forecastedr/collections/dkss_nsbs/instances`
- Felt: `instances[].id`. Tag den største tid inden for de seneste 24 timer. Et id i fremtiden eller ældre end 24 timer tæller ikke. Eksempel: `{"instances":[{"id":"2026-11-26T150000Z"},{"id":"2026-11-26T120000Z"}]}` bliver `2026-11-26T15:00:00.000Z`.
- Manifest: `GET https://jsnielsendk.github.io/sejl-sikkert-data/manifest.json?t=<GITHUB_RUN_ID>` feltet `modelRuns[].modelRunAt` for samme `modelRuns[].model`. Nyere DMI-tid bygger.

`keepalive.yml` committer `keepalive.txt` den 1. i måneden. GitHub slår planlagte workflows fra efter 60 dage uden aktivitet i repoet, og den månedlige commit holder dem i gang. `contents: write` gælder kun det job.

## Licens

Koden i dette repo er MIT. Se [LICENSE](LICENSE).

Vejrdataene er bearbejdet DMI-data og er under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/):

Kilde: DMI (Danmarks Meteorologiske Institut), bearbejdet.
