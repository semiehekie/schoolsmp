# schoolsmp stemsite

Stemwebsite voor een Minecraft-server. Spelers kiezen hun naam en kandidaat in de stemperiode; er is geen stemcode nodig. De top 3 van de uitslag vormen de kamer die de straffen bedenkt.

## Starten

1. Installeer Node.js 20 of hoger.
2. Maak in de projectmap een kopie van `.env.example` met de naam `.env`.
3. Vul `DATABASE_URL` in met de Neon connection string van je project (in Neon: **Project → Connect → Connection string**). Laat `?sslmode=require` staan als Neon dat meegeeft.
4. Vervang `ADMIN_PASSWORD` door een lang, uniek wachtwoord.
5. Voer `npm install` uit en daarna `npm start`.
6. Open `http://localhost:3000`. De beheerpagina staat op `http://localhost:3000/admin`.

Bij de eerste start maakt de server automatisch de benodigde tabellen in je Neon-database aan. De opgegeven kandidaten/partijen en stemgerechtigde spelers worden eenmalig toegevoegd als startlijst; bestaande gegevens worden niet overschreven. Daarna beheer je de lijsten via `/admin`.

## Beheer

- Plak in **Spelerslijst** één Minecraft-naam per regel en sla op.
- Voeg kandidaten en hun partij/groep toe en sla ze op.
- De eerste stemming staat ingesteld op 2 november 2026 van 19:00 tot 20:00 (Nederlandse tijd). Daarna kan er om de week op zaterdag gestemd worden; de stemming sluit aan het einde van zaterdag en de uitslag wordt zondag om 20:00 bekendgemaakt.
- Werk de kandidatenlijst voor de nieuwe ronde bij.
- Bekijk de live tussenstand en download de uitslag als CSV.

De startpagina toont ook de servergrondregels, strafniveaus en de ingediende partijpunten. Extra regels mogen de grondregels aanscherpen of aanvullen, niet versoepelen.

De publieke pagina ververst de uitslag automatisch. Stemmen is vrijwillig: een ronde sluit op de geplande tijd, ook als niet iedereen heeft gestemd. Per naam kan maximaal één stem per gewone ronde worden uitgebracht. Als bij de uitslag minder dan drie kandidaten stemmen hebben, volgt direct een aparte stemming van één uur voor plek drie. De eerste twee plekken blijven vaststaan en iedereen kan opnieuw stemmen, ook wie al in de gewone ronde heeft gestemd. In `/admin` zie je de uitslag van die extra ronde en kun je de start- en einddatum/tijd aanpassen. Runoff-stemmen worden in aparte nieuwe tabellen opgeslagen; oude stemrecords blijven onaangepast in de database. Let op: zonder code of accountverificatie kan de site niet controleren wie een Minecraft-naam bezit. Oude stemmen blijven bewaard als een speler of kandidaat uit de actieve lijst wordt gehaald.

## Belangrijk

De `.env` bevat geheime gegevens en wordt door `.gitignore` uitgesloten. Zet die nooit in een openbare repository of deel de Neon connection string. De admin-login is een eenvoudige server-side sessie die verloopt na acht uur; voor productie achter een publieke URL is HTTPS vereist.
