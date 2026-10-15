# Prognosebasierte thermische Rollladensteuerung für ioBroker

**Status:** Fachkonzept / Spezifikation für Version 1  
**Stand:** 11. Oktober 2026  
**Standort der Wetterprognose:** 56567 Neuwied, näherungsweise 50,47° N / 7,47° E  
**Zeitzone:** Europe/Berlin

## 1. Zielsetzung

Eine ioBroker-Anwendung soll Rollläden raumweise so steuern, dass möglichst viel **nützliche solare Wärme** in das Gebäude gelangt, gleichzeitig aber **unerwünschte Überhitzung** vermieden wird. Grundlage sind Wetter- und Solarstrahlungsprognosen für einen rollierenden Horizont von 24 Stunden sowie Raumtemperaturen, Fensterdaten und vereinfachte thermische Raumparameter.

- **Winter:** Hohe Solargewinne zulassen. Kurzzeitige Raumtemperaturen bis etwa 25 °C können erwünscht sein, wenn der Raum anschließend abkühlt; Solarwärme kann Heizenergie ersetzen.
- **Sommer:** Bei kleinem oder negativem thermischem Abkühlbudget konsequent verschatten; möglichst keine Überschreitung der gewünschten Temperatur.
- **Übergangszeit:** Zwischen diesen Verhaltensweisen kontinuierlich anhand der Prognose wechseln, nicht anhand fixer Kalendermonate.
- **Heizung:** Ausschließlich lesen und im Modell berücksichtigen. **Version 1 erteilt niemals Heizungsbefehle.**
- **Bedienbarkeit:** Globale Deaktivierung, Tagesdeaktivierung, Urlaubsmodus sowie je Fenster Aktivierung, morgendliche Teilnahme und manuelle 60-Minuten-Sperre.

## 2. Leitprinzip und Architektur

Die Architektur trennt strikt:

1. **Datenerfassung:** Wetterprognose, Raumtemperatur, Heizungszustand, Rollladen-Istwerte.
2. **Thermisches Modell:** 24-h-Abkühlpotenzial, stündliche Solarwärme, simulierte Raumtemperatur.
3. **Verschattungsoptimierung:** Pro Fenster optimale Positionen und deren Begründung berechnen.
4. **Freigabe-/Betriebslogik:** Prüfen, ob ein geplanter Fahrbefehl überhaupt ausgeführt werden darf.
5. **Aktorik:** Nur freigegebene Befehle an Rollläden senden und eigene Befehle nachverfolgen.

Die Betriebslogik hat Vorrang vor thermischen Empfehlungen. Die Optimierung wird rollierend wiederholt; ausgeführt wird jeweils nur der aktuell freigegebene Schritt.

## 3. Wetter- und Strahlungsprognose

### 3.1 Bevorzugte Quelle: Open-Meteo

Für ein Fenster ist nicht die horizontale Globalstrahlung (`shortwave_radiation`, GHI), sondern **Global Tilted Irradiance** (`global_tilted_irradiance`, GTI/POA) auf die **senkrechte Fensterfläche** maßgeblich. Diese enthält direkte, diffuse und modellierte reflektierte Anteile. Einheit: W/m²; die stündlichen Mittelwerte lassen sich in Wh/m² überführen.

API: https://open-meteo.com/en/docs

Beispiel für ein Fenster in Richtung 160° (Kompassazimut von Nord im Uhrzeigersinn) in Neuwied:

```text
https://api.open-meteo.com/v1/forecast?latitude=50.47&longitude=7.47&hourly=global_tilted_irradiance,temperature_2m&tilt=90&azimuth=-20&timezone=Europe%2FBerlin&forecast_days=2
```

**Winkelkonvention:** Open-Meteo erwartet Süd = 0°, Ost = −90°, West = +90°. Umrechnung für Kompassazimut α (Nord = 0°, Ost = 90°): `azimuth_openmeteo = ((α - 180 + 540) % 360) - 180`. Alle Fenster: `tilt=90`.

| Fenster-Azimut (Kompass) | Richtung | Open-Meteo-Azimut |
|---:|---|---:|
| 70° | Ost-Nordost | −110° |
| 160° | Süd-Südost | −20° |
| 250° | West-Südwest | +70° |

Die Prognose wird **für 24 Stunden ab jetzt** benötigt (nicht nur für den Kalendertag). Das API-Zeitfenster so laden, dass der aktuelle Zeitpunkt und mindestens die nächsten 24 Stunden abgedeckt sind; Prognosen zeitlich korrekt auf ein einheitliches Intervallraster abbilden. Sommerzeitwechsel berücksichtigen. Bei identischer Ausrichtung können mehrere Fenster dieselbe GTI-Zeitreihe nutzen.

**Kosten:** Die nichtkommerzielle Open-Meteo-Nutzung ist innerhalb der jeweils aktuellen Nutzungsgrenzen kostenlos; Nutzungsbedingungen und kommerzielle Tarife vor Verteilung/Betrieb prüfen.

### 3.2 Alternative Quellen und Qualitätssicherung

| Quelle | Daten | Rolle | Kostenhinweis |
|---|---|---|---|
| Open-Meteo Forecast | Stündliche GTI, GHI, Bewölkung, Temperatur | Primär | Nichtkommerziell i. d. R. kostenlos im Freikontingent |
| Open-Meteo DWD ICON | Modellbasierte regionale Strahlung und Temperatur | Alternativ-/Vergleichsmodell | Nichtkommerziell im Freikontingent |
| DWD MOSMIX | `Rad1h` Globalstrahlung (horizontale Ebene), stündlich | Kontrolle; für Fenster Umrechnung auf POA notwendig | Open Data, kostenlos |
| Visual Crossing | `solarradiation` (horizontale Strahlung) | Unabhängiger Vergleich, ggf. selbst auf Fenster transponieren | Freikontingent; Tarif prüfen |
| Solcast / OpenWeather Solar | Spezialisierte Strahlungsprognosen, ggf. DNI/DHI | Option bei höherem Genauigkeitsbedarf | Je nach Produkt kostenpflichtig; Solcast-Hobby-PV-API ist nicht gleich direkter GHI-Zugang |
| Satellitenbeobachtungen | Aktuelle zurückliegende Strahlung | Plausibilitäts-/Kurzfristkorrektur | Anbieterabhängig, teils kostenlos |
| PVGIS | Historische Solarstrahlung | Kalibrierung/Referenzprofile, **keine** aktuelle 24-h-Prognose | Kostenlos |

DWD MOSMIX `Rad1h` in kJ/m² kann mit `W/m² = (kJ/m²) / 3,6` in den stündlichen Mittelwert umgerechnet werden. GHI ist nicht identisch mit GTI: Für eine eigene POA-Umrechnung braucht man idealerweise DNI, DHI, Sonnenstand und Bodenreflexion.

**Indirekte Näherungen** bei fehlender GTI: (1) Clear-Sky-Strahlung und Bewölkungsmodell, (2) DNI/DHI plus Sonnengeometrie, (3) historische Tagesprofile plus Bewölkungsanpassung, (4) Sonnenscheindauer, (5) PV-Ertragsprognosen als grober relativer Helligkeitsindikator. Direkte GTI ist für Version 1 vorzuziehen.

## 4. Raum- und Fensterkonfiguration

### 4.1 Je Raum

- Stabiler Raumbezeichner, Temperatur-Ist-Datenpunkt und gegebenenfalls Heizungs-Sollwert (nur lesend).
- **Solltemperatur 21 °C** als Standardreferenz für das Wärmebudget.
- Vereinfachter Wärmeverlustkoeffizient **H in W/K**, vom Benutzer vorgegeben. Er soll im Idealfall Transmission und übliche Lüftungsverluste grob abdecken.
- Raumfläche in m² und Bauweiseklasse zur Abschätzung der thermischen Kapazität C.
- Heizungsart: keine / Heizkörper / Fußbodenheizung.
- Zugeordnete Fensterliste; Fenster können verschiedenen Fassaden zugewiesen sein.

### 4.2 Je Fenster

- Fenster-/Rollladenname, Raumzuordnung, Glasfläche **A** in m², Kompassazimut in Grad, Fensterebene in Version 1 senkrecht (90°).
- Gesamtenergiedurchlassgrad **g** der Verglasung; bei unbekanntem Wert konfigurierbaren Standard einsetzen.
- Rollladen-Datenpunkte für Sollposition und Istposition sowie gegebenenfalls Bewegung/Status. **Polung und Wertebereich je Adapter explizit konfigurieren** (z. B. 0 = geschlossen oder 0 = offen).
- Benutzer-Bool `enabled`: Teilnahme an der normalen thermischen Steuerung.
- Benutzer-Bool `autoMorningOpen`: tägliche automatische Öffnung erlaubt oder erst Teilnahme nach der ersten *fremd ausgelösten* Öffnung des Tages.
- Interne Felder: `participatingToday`, `manualHoldUntil`, `lastOwnCommand`, `actualPosition`, `calculatedPosition`, `controlReason`.

## 5. Thermische Bilanz

### 5.1 Klimatisches Brutto-Abkühlbudget

Bei 21 °C Innenreferenz und stündlicher Außentemperaturprognose:

\[
B_{24}=\sum_{k=1}^{24} H\,(21-T_{a,k})\,\Delta t
\]

mit H in W/K, Δt in h und Ergebnis in Wh. Ein positives Budget steht für potentiellen Wärmeverlust; ein negatives Budget beschreibt netto Wärmeeintrag aus wärmerer Umgebung. **Ein negatives Budget lässt sich nicht allein durch Verschattung ausgleichen.**

Normierter Index:

\[
K=\frac{B_{24}}{24\,h\cdot H}
\]

Für konstantes H entspricht K der Differenz zwischen 21 °C und dem prognostizierten 24-h-Mittel der Außentemperatur. Er ist ein **Klimasignal**, keine vollständige Aussage über den aktuellen thermischen Zustand des Raums.

### 5.2 Adaptive Temperaturtoleranz

Ein vorläufiger, konfigurierbarer Vorschlag:

\[
T_{max}=21+4\cdot\operatorname{clamp}\left(\frac{K-1}{7},0,1\right)
\]

Somit: bei warmem Wetter nahe 21 °C, bei hoher Abkühlreserve bis 25 °C. Das ist eine **heuristische Komfortkennlinie, kein physikalisches Gesetz**. Sie sollte geglättet und ggf. mit Hysterese betrieben werden. Eine spätere Diskussion kann 21 °C als Komfortziel und eine getrennte harte Temperaturgrenze definieren. Bei nicht erreichbarem Ziel minimiert der Optimierer die Überschreitung, statt unendliche Verschattung zu verlangen.

### 5.3 Kapazität C aus Raumfläche

Startschätzung:

\[
C=A_{Raum}\,c_{spezifisch}
\]

Orientierende effektive Klassen für das Einzonenmodell:

| Bauweise | Beispielwert c in Wh/(m²·K) |
|---|---:|
| Sehr leicht | 22 |
| Leicht | 31 |
| Mittel (Standard) | 46 |
| Schwer | 72 |
| Sehr schwer | 103 |

Für 25 m² mittlere Bauweise: C ≈ 1.150 Wh/K. Werte sind nur Initialisierungen, da thermisch wirksame Masse, Zeitfenster und Raumeinrichtung abweichen. Die Zeitkonstante ist näherungsweise `τ = C/H` in Stunden. C und H können später aus geeigneten Temperaturverläufen verbessert werden.

### 5.4 Solarwärme pro Fenster

Unverschattete solare Leistung:

\[
P_{solar,i,k}=GTI_{i,k}\cdot A_i\cdot g_i
\]

Mit Rollladenposition s und einem dimensionslosen Durchlassfaktor f(s):

\[
P_{solar,Raum,k}=\sum_i GTI_{i,k}\,A_i\,g_i\,f_i(s_{i,k})
\]

f = 1 bedeutet keine Verschattung; f nahe 0 starke Verschattung. Eine lineare f-Kennlinie ist höchstens ein **Startmodell**: 60 % Fahrweg ist nicht automatisch 60 % weniger Wärme. Direkte Sonne, diffuse Strahlung, Geometrie des noch sichtbaren Glasausschnitts, Bodenreflexion und sekundäre Wärmeabgabe des außenliegenden Rollladens beeinflussen die Wirkung. Später f anhand von Sonnenstand, DNI/DHI und Fenstergeometrie verfeinern bzw. empirisch kalibrieren.

### 5.5 Vereinfachtes Temperaturmodell

Ein-Zonen-Modell mit Stunden- oder Viertelstundenraster:

\[
T_{k+1}=T_k+\frac{\Delta t}{C}\left[P_{solar,k}+P_{heat,k}+P_{internal,k}-H(T_k-T_{a,k})\right]
\]

Dabei ist Δt in Stunden und C in Wh/K. Der Ausgangspunkt **ist immer die aktuell gemessene Raumtemperatur**, nicht eine fiktive 21-°C-Temperatur. Für numerische Robustheit oder sehr kleine C/H kann ein exakter diskreter RC-Schritt statt der expliziten Euler-Näherung verwendet werden.

**Wichtig:** Das 24-h-Budget darf nicht unabhängig vom aktuellen Speicherzustand als täglich neu verfügbares Kontingent ausgeschöpft werden. Eine stündliche Simulation verhindert, dass mittägliche Überhitzung durch nächtliche Abkühlung in der bloßen Tagesbilanz verschleiert wird.

## 6. Heizung: Nur Beobachtung, keine Steuerung

**Verfügbare ioBroker-Informationen:** Raum-Ist-/Solltemperatur, Heizkörper-Ventilöffnung in %, Heizanforderung bzw. Heizkreis EIN/AUS, zentraler Vor- und/oder Rücklauftemperaturwert. Vor-/Rücklaufwerte gelten **für die gesamte Anlage**, nicht pro Raum.

Es existiert **kein** bekannter Volumenstrom je Raum und keine raumbezogene gemessene Heizleistung. Deshalb sind Ventilposition und zentrale Wassertemperaturen **Indikatoren, keine Watt-Messung**. Schätzwerte sind mit Unsicherheit zu kennzeichnen.

### 6.1 Heizkörper

- Die bestehende Thermostatregelung bleibt aktiv und wird nicht überschrieben.
- Sonnenwärme kann die Heizkörperleistung rasch ersetzen; bei hoher Sonne im Winter deshalb Verschattung zurückhaltend einsetzen.
- Ein einfaches Heizmodell kann Soll-/Ist-Temperatur, Ventilöffnung, Heizanforderung und zentrale Vor-/Rücklauftemperaturen verwenden, um die grobe relative Heizleistung abzuschätzen.
- Optional: Kennlinie `P_HK ≈ P_N (ΔT/50 K)^n f_ventil(v)`, mit n grob 1,3 und unbekanntem P_N. **Nicht** annehmen, dass 50 % Ventilöffnung 50 % Heizleistung sind. Modellparameter zunächst heuristisch und konservativ, später lernen.

### 6.2 Fußbodenheizung

- Träges Verhalten berücksichtigen: Abschalten der Heizanforderung beendet die Wärmeabgabe aus dem warmen Estrich nicht sofort.
- In Version 1 eine **vereinfachte Nachlauf-Wärmequelle** verwenden, die auf Heizkreiszustand und zentralem Heizwasserniveau basiert; die Wärmeabgabe entwickelt sich langsam.
- Bei späterem Ausbau: Zweizustandsmodell mit Estrichkapazität `C_F` und Raumkapazität `C_R`, etwa:

\[
C_F\,\frac{dT_F}{dt}=P_{Wasser}-K_F(T_F-T_R),\qquad P_{FBH\to R}=K_F(T_F-T_R)
\]

- Die Estrichmasse darf beim Zweizustandsmodell **nicht zugleich vollständig in C_R** stecken (Doppelzählung vermeiden).
- Heizkreis EIN/AUS zeigt Wärmeanforderung beziehungsweise Ventilzustand, nicht unmittelbar abgegebene Raumleistung.
- Wenn die Heizung im Sommer aus ist, darf das Modell nicht weiterhin automatisch 24 Stunden eine konstante Heizleistung ansetzen.

### 6.3 Budgets einschließlich Heizung

Diagnosewerte getrennt halten:

- `climateBudget24h`: Brutto-Abkühlpotential bei 21 °C.
- `heatingEnergyPredicted24h`: geschätzte Heizwärme im simulierten 24-h-Horizont (nur lesend).
- `solarPotential24h`: maximal mögliche solare Wärme bei offenen Rollläden.
- `solarAllowed24h`: prognostizierte unter Komfortbedingungen sinnvoll aufnehmbare Solarwärme.

Als grobe Bilanz um 21 °C ist `B_solar ≈ B_24 - E_heating - E_internal + C(21 - T_now)` möglich. **Bei trägen Fußbodenheizungen muss zusätzliche gespeicherte Estrichenergie berücksichtigt werden.** Für Stellentscheidungen immer zeitaufgelöste Simulation statt bloßer Summenbilanz.

## 7. Optimierungsstrategie

Alle 15 Minuten (Vorschlag):

1. Neue/zwischengespeicherte Prognose mit aktuellem Sensorzustand abgleichen.
2. Für jeden Raum 24-h-Klimabudget und adaptive Temperaturgrenze berechnen.
3. Temperaturverlauf bei geöffneten Rollläden simulieren, einschließlich des geschätzten **unveränderten** Heizungsverhaltens.
4. Bei drohender Überschreitung alternative Rollladenpositionen je Fenster und Zeitschritt prüfen.
5. Verschattungsplan wählen, der Temperaturgrenzen möglichst einhält und dabei Solargewinne/Tageslicht möglichst erhält und Fahrbewegungen reduziert.
6. **Nur den ersten aktuellen Sollwert** des optimierten Plans über die Betriebslogik freigeben; dann regelmäßig neu rechnen.

Beispiel-Zielfunktion:

\[
J=w_T\sum_k\max(0,T_k-T_{max,k})^2+w_S E_{blocked}+w_M N_{moves}
\]

Die Gewichtungen sollen Temperaturüberschreitungen im Sommer stark bestrafen, im Winter gewünschte Solarwärme weitgehend zulassen und kleine Fahrbewegungen vermeiden. Heizkostenersparnis durch Solarwärme kann perspektivisch als zusätzlicher Nutzen terminiert werden. Werden die Komfortgrenzen physikalisch unerreichbar, bestmögliche Schadensbegrenzung und Diagnose melden.

In Version 1 genügt zunächst ein diskretes Stellraster, z. B. 0/25/50/75/100 % Rollladenschließung; Mindestbewegung und Hysterese beachten. Später eine sonnenspezifische, geometrisch differenzierte Regelkennlinie ergänzen.

## 8. Betriebslogik und eindeutige Priorität

**Prioritäten von hoch nach niedrig:**

1. `global.enabled == false` → **keine** automatischen Fahrbefehle.
2. `global.disabledToday == true` → **keine** automatischen Fahrbefehle bis Tagesende.
3. Fenster hat aktive **manuelle 60-Minuten-Sperre** → dieses Fenster nicht automatisch bewegen.
4. `global.vacationMode == true` → **Urlaubsroutine** für **alle konfigurierten** Rollläden, unabhängig von `window.enabled` und `window.autoMorningOpen`.
5. `window.enabled == false` → dieses Fenster im Normalbetrieb vollständig ignorieren.
6. `window.autoMorningOpen == false` und `participatingToday == false` → nicht automatisch bewegen, zunächst fremde tägliche Öffnung abwarten.
7. Andernfalls normale thermische Rollladenregelung, inklusive eventueller morgendlicher Öffnungsroutine.

**Hinweis:** Im Normalbetrieb ist bisher keine verpflichtende automatische Abendschließung definiert; eine solche Routine wäre eine eigene spätere Entscheidung.

### 8.1 Globale Schalter

| Datenpunkt | Bedeutung | Persistenz |
|---|---|---|
| `global.enabled` | Haupt-EIN/AUS | Bleibt bis zu manueller Änderung |
| `global.disabledToday` | Automatik nur für den heutigen Tag aus | Automatischer Reset um lokales 00:00; muss Neustart überleben |
| `global.vacationMode` | Zeit-/Sonnenstandsbasierter Urlaubsbetrieb | Bleibt bis zu manueller Änderung |

Das Tagesflag muss über Sommer-/Winterzeitwechsel und Neustarts sicher geführt werden, z. B. mit einem gespeicherten zugehörigen lokalen Datum. Um Mitternacht kein ungewollter Rollladenfahrbefehl. Urlaubsroutine bei fehlenden Wetterprognosen weiterhin nutzbar.

### 8.2 Individuelle Fensterfreigabe

- `window.enabled`: normales thermisches Regelverhalten ja/nein.
- `window.autoMorningOpen`: automatisches Öffnen am Morgen erlaubt ja/nein.
- Bei `autoMorningOpen=true`: Zum konfigurierten Zeitfenster öffnen (z. B. nach Sonnenaufgang, frühestens 07:00), anschließend Teilnahme erlauben. Frühöffnung und thermische Beschattung klar nacheinander ausführen, nicht gegeneinander pendeln.
- Bei `autoMorningOpen=false`: Erst nach der **ersten fremd ausgelösten Öffnung am jeweiligen Kalendertag** teilnahmeberechtigt; Vorschlag: als Öffnung zählt erst eine Position von mindestens 90 % offen. Eine solche fremde Öffnung löst zugleich die manuelle 60-Minuten-Sperre aus.
- `participatingToday` jeden lokalen Kalendertag zurücksetzen. Fensterzustand und eigene Tagesaktionen nach Restart konsistent rekonstruieren.

### 8.3 Manuelle Änderung und 60-Minuten-Sperre

Eine **fremd ausgelöste** Positionsänderung sperrt nur das betreffende Fenster für 60 Minuten. Weitere manuelle Änderungen starten die Frist neu. Nach Ablauf neu optimieren, nicht ungeprüft zu einer alten Position zurückfahren. Die Sperre gilt auch im Urlaub.

Bei ioBroker reicht `ack` allein zur Erkennung nicht aus. Der Controller speichert eigene Befehle mit Zielposition, Zeitstempel, erwarteter Fahrdauer, Toleranzen sowie gegebenenfalls `from`-Kennzeichen. Externe Sollwertänderungen, erkannte fremde Fahrbewegungen oder unzuordenbare Bewegungen gelten als manuell (konservativ). Eigene Sollwert- und Istwert-Rückmeldungen dürfen keine Sperre auslösen. Bei stark unzuverlässigen Geräteadaptern separate Soll- und Ist-IDs bzw. Quell-ID nutzen; Fehlklassifikationen im Log sichtbar machen.

**Sperren müssen Neustarts überleben.** Bei gleichzeitigen manuellen und automatischen Befehlen muss der manuelle Vorrang garantiert werden. Während des Systemsperrzustands werden keine neuen eigenen Fahrbefehle erzeugt.

### 8.4 Urlaubsmodus

- Für **sämtliche** konfigurierten Rollläden: morgens öffnen, abends schließen.
- Fenster-Flags `enabled` und `autoMorningOpen` ignorieren.
- Globale/Tagesdeaktivierung sowie manuelle Sperren respektieren.
- Zeitpunkte aus Sonnenaufgang/-untergang mit einstellbaren Unter-/Obergrenzen und Offsets; optional später Anwesenheitssimulation mit kleinen Zufallsvariationen.
- Benötigt keine Solarprognose und darf bei Forecast-Ausfall funktionieren.
- Wechsel zwischen Urlaubs- und Normalbetrieb: keine überraschenden sofortigen Nachholfahrten ohne Prüfung.

## 9. Sicherheits-, Qualitäts- und Ausfallregeln

Startvorschläge:

| Regel | Vorschlag |
|---|---|
| Rechenzyklus / MPC | Alle 15 Minuten |
| Wetteraktualisierung | Etwa stündlich |
| Sensor-/Aktorbeobachtung | Ereignisbasiert, ggf. 1–5 Minuten |
| Mindeständerung für neuen Fahrbefehl | 10 Prozentpunkte |
| Abstand zwischen automatischen Fahrten | 15 Minuten |
| Manuelle Übersteuerung | 60 Minuten je Fenster |
| Prognose ungültig / zu alt | Keine neu optimierten thermischen Fahrbefehle; sichere Zustände dokumentieren |
| Neustart | Betriebsflags, Tagesstatus, Sperren und Kommandonachverfolgung wiederherstellen; keine blinde sofortige Fahrt |

Weitere Empfehlungen:

- **Position convention:** All normalized positions, diagnostics, plans and simulator controls use **100 = fully open, 0 = fully closed**. Raw device endpoints are mapped explicitly at the adapter boundary.
- Für den Fall defekter Sensoren, unplausibler Temperaturen, fehlender Positionen oder veralteter Prognosen klaren **Degradationsmodus** definieren; manuelle Bedienbarkeit erhalten.
- Rolladen-Grenzen, Fahrtdauer und eventueller Hindernisschutz verbleiben bei den jeweiligen Aktoren.
- Bei stark wechselnder Bewölkung nicht häufig hin- und herfahren; Hysterese und Mindestfahrzeit nutzen.
- Logging pro Befehl: Grund, Datenzeitpunkt, prognostizierter Effekt, Sperrstatus und tatsächliche Rückmeldung.

## 10. ioBroker-Datenpunkte (Entwurf)

Beispielhafter Namensraum: `0_userdata.0.thermalShading` (bei Implementierung als eigenständiger Adapter ggf. eigenes Namespace verwenden).

```text
thermalShading
├── global
│   ├── enabled                  [bool, write]
│   ├── disabledToday            [bool, write]
│   ├── vacationMode             [bool, write]
│   ├── operatingMode            [string, read]
│   ├── forecastValid            [bool, read]
│   └── lastForecastUpdate       [timestamp, read]
├── rooms
│   └── <roomId>
│       ├── currentTemperature   [°C, read]
│       ├── climateBudget24h     [Wh, read]
│       ├── solarPotential24h    [Wh, read]
│       ├── solarAllowed24h      [Wh, read]
│       ├── predictedMaxTemp     [°C, read]
│       ├── adaptiveTempLimit    [°C, read]
│       └── modelQuality         [optional, read]
└── windows
    └── <windowId>
        ├── enabled              [bool, write]
        ├── autoMorningOpen      [bool, write]
        ├── participatingToday   [bool, read]
        ├── manualOverrideActive [bool, read]
        ├── manualHoldUntil      [timestamp, read]
        ├── calculatedPosition   [%, read]
        ├── actualPosition       [%, read]
        └── controlReason        [string, read]
```

Exemplarische `controlReason`-Werte: `THERMAL_PROTECTION`, `SOLAR_GAIN`, `MORNING_OPEN`, `VACATION_OPEN`, `VACATION_CLOSE`, `MANUAL_LOCK`, `WAIT_FIRST_OPEN`, `WINDOW_DISABLED`, `SYSTEM_DISABLED`, `DISABLED_TODAY`, `FORECAST_INVALID`, `NO_CHANGE`.

### Beispielkonfiguration (schematisch)

```json
{
  "global": {
    "enabled": true,
    "disabledToday": false,
    "vacationMode": false,
    "timezone": "Europe/Berlin",
    "manualOverrideMinutes": 60,
    "optimizationIntervalMinutes": 15
  },
  "rooms": [
    {
      "id": "wohnzimmer",
      "temperatureSensorId": "alias.0.wohnzimmer.temperature",
      "targetTemperatureC": 21,
      "heatLossWK": 80,
      "floorAreaM2": 25,
      "construction": "medium",
      "heating": {
        "type": "radiator",
        "setpointId": "alias.0.wohnzimmer.heatingSetpoint",
        "demandId": "alias.0.wohnzimmer.heatingDemand",
        "valvePositionId": "alias.0.wohnzimmer.valve"
      }
    }
  ],
  "windows": [
    {
      "id": "wohnzimmer_ost",
      "roomId": "wohnzimmer",
      "azimuthDeg": 70,
      "tiltDeg": 90,
      "glassAreaM2": 3.5,
      "gValue": 0.5,
      "enabled": true,
      "autoMorningOpen": false,
      "positionStateId": "alias.0.rollladen.ost.actual",
      "positionCommandId": "alias.0.rollladen.ost.target",
      "openIsPercent": 100
    },
    {
      "id": "wohnzimmer_sued",
      "roomId": "wohnzimmer",
      "azimuthDeg": 160,
      "tiltDeg": 90,
      "glassAreaM2": 5.0,
      "gValue": 0.5,
      "enabled": true,
      "autoMorningOpen": true,
      "positionStateId": "alias.0.rollladen.sued.actual",
      "positionCommandId": "alias.0.rollladen.sued.target",
      "openIsPercent": 100
    },
    {
      "id": "wohnzimmer_west",
      "roomId": "wohnzimmer",
      "azimuthDeg": 250,
      "tiltDeg": 90,
      "glassAreaM2": 4.0,
      "gValue": 0.5,
      "enabled": true,
      "autoMorningOpen": true,
      "positionStateId": "alias.0.rollladen.west.actual",
      "positionCommandId": "alias.0.rollladen.west.target",
      "openIsPercent": 100
    }
  ],
  "centralHeating": {
    "flowTemperatureId": "alias.0.heating.flow",
    "returnTemperatureId": "alias.0.heating.return"
  }
}
```

Die IDs, Flächen, W/K- und g-Werte im Beispiel sind **Platzhalter**, keine gemessenen Werte. In der Implementierung wird das Positionsformat ausdrücklich je Aktor normalisiert.

## 11. Umsetzung in Etappen

### Phase 1 – Betriebssicherheit ohne thermische Fahrbefehle

- Konfigurationsmodell für Räume, Fenster, Heizungsbeobachtung.
- Globale/Tagesdeaktivierung, Urlaubsmodus und Fensterflags.
- Tageswechsel, morgendliche Teilnahme und manuelle 60-Minuten-Sperren.
- Robuste Eigenerkennung von Fahrbefehlen und persistenter Zustand.
- Test mit simulierten oder echten Rollläden **ohne** thermische Optimierung.

### Phase 2 – Prognose und Simulation im Schattenbetrieb

- Wetter- und GTI-Prognosen für 24 Stunden und alle Ausrichtungen.
- H, C, Wärmebudget, GTI × Fläche × g, einfache Heizungsmodelle.
- Adaptive Temperaturgrenze und Temperaturverlauf.
- `calculatedPosition` und Diagnosewerte berechnen, aber keine thermisch motivierten Fahrten auslösen.
- Prognosen gegen reale Temperaturverläufe prüfen; Modellfehler protokollieren.

### Phase 3 – Aktive thermische Verschattung

- MPC-/Rasteroptimierung mit Mindestfahrabstand und Hysterese.
- Freigabelogik vor jeder Bewegung; manuelle Bedienung bleibt dominant.
- Monitoring pro Raum: Budget, erwartete Maximaltemperatur, vermiedener Wärmeeintrag, Fahrbefehlsgrund.
- Konservative Fallbacks bei schlechten Daten.

### Phase 4 – Qualitätsverbesserung

- H/C aus geeigneten Messphasen kalibrieren; Heizungsleistungskennlinien und FBH-Nachlauf lernen.
- Präzisere Verschattungswirkung aus direkter/diffuser Strahlung, Sonnenstand und Fenstergeometrie.
- Gewichten von Komfort, Tageslicht, Solarwärmenutzung und Aktorverschleiß.
- Modellfehler/Unsicherheit als Sicherheitsreserve in der Optimierung berücksichtigen.

## 12. Testfälle / Akzeptanzkriterien

1. **Global AUS:** Kein automatischer Fahrbefehl, auch nicht im Urlaub.
2. **Heute AUS:** Keine Automatik bis zum lokalen Tageswechsel; Neustart setzt nicht vorzeitig zurück.
3. **Urlaub EIN:** Auch `enabled=false`-Fenster fahren morgens/abends; manuelle Sperre bleibt wirksam.
4. **Normal, Fenster deaktiviert:** Kein automatischer Befehl für dieses Fenster.
5. **`autoMorningOpen=false`:** Vor erster fremder Öffnung keine thermische Teilnahme; danach 60 Minuten Sperre.
6. **Manuelle Bewegung:** Innerhalb einer Stunde keine eigene Bewegung; erneute manuelle Änderung verlängert die Sperre.
7. **Eigener Befehl:** Rückmeldungen und Zwischenpositionen starten keine manuelle Sperre.
8. **Winterwetter:** Hoher positiver K-Wert erlaubt höhere kurzzeitige Temperaturen, maximal gemäß konfigurierter Kennlinie.
9. **Heiße Periode:** Negatives Budget führt zu enger Temperaturtoleranz und früher Verschattung, ohne einen unrealistischen 21-°C-Erfolg zu behaupten.
10. **Heizkörper:** Bei vorausgesagter Sonne darf die geschätzte Heizleistung sinken; keine direkte Heizungssteuerung.
11. **FBH:** Nach Abschalten des Heizkreises bleibt für eine Zeit positive Restwärme im Modell.
12. **Prognoseausfall:** Keine ungesicherten thermischen Fahrten; Urlaubszeitplan funktioniert weiterhin.
13. **Sommerzeitwechsel:** 24-h-Prognose und Tagesflags bleiben zeitlich konsistent.
14. **Mehrere Fenster/Räume:** Verschiedene Ausrichtungen und Sperren werden unabhängig behandelt.

## 13. Noch zu klärende fachliche Entscheidungen

- Soll 21 °C im Hochsommer **harte obere Grenze**, Komfortziel oder Start einer weichen Überschreitungsstrafe sein? Welche harte absolute Sicherheits-/Komfortgrenze gilt?
- Welche Temperaturuntergrenze muss ohne Eingriff in die Heizung respektiert werden?
- Soll im Normalbetrieb auch eine automatische Abend-/Nachtschließung existieren (aktuell nicht spezifiziert)?
- Exakte Urlaubszeiten bzw. Sonnenstands-Offsets und Regeln für verspätete Aktivierung.
- Was gilt als erste „Öffnung“ bei `autoMorningOpen=false`: nur nahezu vollständig offen (Vorschlag ≥ 90 %) oder eine kleinere Schwelle?
- Wie wird die Wirkung teilgeschlossener Rollläden initial modelliert (linearer f-Faktor vs. Sonnengeometrie)?
- Welche voreingestellten g-Werte, H-Werte und Standardparameter der Heizmodelle gelten ohne Kalibrierung?
- Sollen Räume mit mehreren Heizsystemen kombiniert werden können?
- Welche Fehlerstrategie gilt bei Aktoren ohne verlässliche Positionsrückmeldung?
- Wie werden gekippte/geöffnete Fenster, besondere Lüftung, lokale Verschattung und außergewöhnliche interne Wärmequellen behandelt? Diese Einflüsse sind in Version 1 nicht explizit modelliert.

## 14. Referenzen und weiterführende Dokumentation

- Open-Meteo Forecast API: https://open-meteo.com/en/docs
- Open-Meteo DWD ICON API: https://open-meteo.com/en/docs/dwd-api
- Open-Meteo Satellite Radiation: https://open-meteo.com/en/docs/satellite-radiation-api
- DWD MOSMIX Open Data: https://opendata.dwd.de/weather/local_forecasts/mos/
- Visual Crossing Weather API: https://www.visualcrossing.com/weather-api/
- PVGIS: https://photovoltaic-geographic-information-system.ec.europa.eu/
- pvlib-python (Clear-Sky-/Strahlungsmodelle): https://pvlib-python.readthedocs.io/
- ioBroker: https://www.iobroker.net/

---

**Kernentscheidung für Version 1:** Nur Rollläden ansteuern. Heizung wird beobachtet und vereinfacht modelliert. Thermische Optimierung und Betriebsfreigabe bleiben getrennt, damit globale Schalter, Urlaub und manuelle Bedienung jederzeit verlässlich Vorrang haben.
