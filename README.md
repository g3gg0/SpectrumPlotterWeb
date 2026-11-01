# SpectrumPlotter Web

Browserbasierte Neuimplementierung von SpectrumPlotter für Desktop-Chrome. Moderne dunkle Oberfläche, Web Serial und vollständig lokale Datenverarbeitung. Keine Installation von Bibliotheken, kein Build, kein Backend und keine externen Laufzeitabhängigkeiten.

## Starten

Im Ordner `SpectrumPlotterWeb`:

```powershell
npm start
```

Anschließend **http://localhost:8080** in Desktop-Chrome öffnen. Alternativ die Dateien über einen beliebigen statischen HTTPS-Server bereitstellen. Der mitgelieferte Node-Server bindet ausschließlich an `127.0.0.1`. Ein anderer Port lässt sich mit der Umgebungsvariablen `PORT` einstellen.

Die Web-Serial-Verbindung erfordert einen sicheren Kontext (localhost oder HTTPS), einen vom Benutzer ausgewählten Port und einen verfügbaren seriellen Treiber. Details zur API: [Chrome Web Serial](https://developer.chrome.com/docs/capabilities/serial). Eine Webseite auf einem entfernten Rechner verbindet sich mit dem seriellen Gerät am Rechner des Browsers.

## Messung

1. Integration, ICG-Periode, Mittelwertanzahl und gegebenenfalls Trigger einstellen.
2. **Connect** drücken und den STM32-Port auswählen. Die App öffnet ihn mit 500000 Baud, 8N1, ohne Handshake und fordert die Kennung `[g3gg0.de]` an. Anschließend prüft sie die Build-Informationserweiterung. Nur ein gültig abgeschlossener Identifikationsablauf aktiviert die Messung. Danach startet die gewählte Aufnahme automatisch.
3. **Live** wiederholt einzelne Messungen. **Pause acquisition** hält nach dem laufenden Frame an. Das Kamerasymbol neben Start fordert genau ein Spektrum an.
4. **Triggered** wartet pro Messung auf die fallende Flanke an **PC13**, dann wird nach der gewählten Verzögerung aufgenommen. Nach jedem vollständigen Frame wird erneut scharfgeschaltet. Optional werden Referenzen verglichen und Aufnahmen automatisch gespeichert.
5. **Stop & disconnect** beendet einen wartenden Triggerbetrieb durch Schließen des Browserports. **Disconnect** ist jederzeit nach erfolgreicher Verbindung verfügbar.

Acquisition-Einstellungen werden während einer laufenden Messfolge gesperrt. Zum Ändern zuerst pausieren beziehungsweise den Triggerbetrieb trennen. Anzeige, Normalisierung, Kalibrierung und Referenz-Overlays bleiben bedienbar.

### Firmware und Zeitangaben

- Ziel ist die vorhandene `tcd1304-advanced`-Firmware, siehe [Firmware-Protokoll](../tcd1304-advanced/README.md). Die Kennung bestätigt die Firmwarefamilie. Neuere Builds liefern zusätzlich Firmwareversion, UTC-Buildzeit, vollständige Commit-ID, Dirty-Status, Branch, Board/MCU, Compiler und konfigurierte Takte. Die Identifikation ist keine elektrische Prüfung der angeschlossenen Optik.
- Sep19 verwendet 115200 Baud und beantwortet den Identifikationsbefehl nicht. Es wird deshalb nicht als verifiziertes Gerät akzeptiert. Die App sendet an ein unbekanntes Gerät keinen Messbefehl.
- SH/ICG werden in tatsächlichen Mikrosekunden angezeigt und bei 2 MHz in **2 Ticks pro µs** übertragen. ICG wird auf das nächste ganzzahlige Vielfache von SH aufgerundet und die angepasste Zeit angezeigt. Mindestwerte: SH 10 µs, ICG 7388 µs. Triggerverzögerung: 0–65535 µs, Mittelwertbildung: 1–15.
- Die Firmware besitzt keinen Abort- oder Disarm-Befehl. Das Schließen des Browserports beendet den Browser-Empfang; eine bereits scharfgeschaltete MCU kann auf einen späteren Trigger weiterhin reagieren. Vor einer erneuten Aufnahme werden Triggerkonfiguration und Messauftrag neu gesendet.
- Die eingestellte Triggerverzögerung wird übertragen; die tatsächliche elektrische Zeitlage und der analoge Messzeitpunkt sind Eigenschaften der Firmware/Hardware und wurden durch die Web-App nicht vermessen.
- Die App benutzt ausschließlich Firmware-One-Shots und startet die nächste Aufnahme nach Empfang des vollständigen Frames. Dadurch überlappen sich Empfang und erneute Anforderung nicht.

`protocol.js` sammelt beliebige Stream-Fragmente zu genau **7388 Byte / 3694 Little-Endian-Samples**. Es gibt keine Spektralheader, CRC oder Sequenznummern. Ein unvollständiger Frame, Empfangsfehler oder Timeout beendet die Verbindung; unvollständige Daten werden nicht geplottet. Im Triggerbetrieb gibt es vor dem ersten Byte keinen Timeout. Sobald Daten eintreffen, gilt ein Empfangslimit von zwei Sekunden ohne Fortschritt. Ein neuer Verbindungsaufbau verwirft vor der Kennungsabfrage alte empfangene Daten.

### Anzeige der Firmware-Buildinformationen

Nach dem ursprünglichen Handshake sendet die App die zusätzliche 12-Byte-Abfrage `45 52 00 00 00 00 FF 42 49 31 02 01`. Eine neue Firmware antwortet mit `[g3gg0.v1]`, einer Big-Endian-Länge und maximal 1024 Byte UTF-8-JSON. Alte Advanced-Firmware beantwortet dieselbe Abfrage mit der bisherigen Kennung `[g3gg0.de]`; sie bleibt nutzbar und wird als Legacy-Firmware ohne Build-Metadaten angezeigt.

Bei **Device verified** stehen Version, kurze Commit-ID und gegebenenfalls `modified`. Das Instrumentenfeld zeigt zusätzlich Datum/Uhrzeit und Commit. Ein Klick auf **Device verified** oder **Firmware & build details** öffnet die vollständige Kennung einschließlich aller 40 Git-Zeichen, Dirty-Status und Buildumgebung. Ein fehlender Git-Checkout erscheint als unbekannte Revision, nicht als sauberer Build. Die Metadaten werden beim Trennen zurückgesetzt und mit neu gespeicherten Hardware-Captures unter `Metadata.buildInfo` exportiert.

Eine ungültige explizite Erweiterungsantwort beendet die Verbindung vor dem ersten Messbefehl. Die App fällt bei beschädigtem JSON oder einem ungültigen Längenfeld nicht stillschweigend auf Legacy zurück.

## Spektren und Referenzen

Über **Import files**, das Import-Symbol in der Bibliothek oder Drag & Drop:

- **`LIBS-*.json`**: C#-Format mit `Name`, `Wavelengths` und `Elements: [{Name, Intensities}]`. Alle enthaltenen Spezies werden separat angezeigt. Mehrere Dateien lassen sich gleichzeitig importieren. Ein erneuter Import derselben Kombination aus Bibliotheksname und Spezies ersetzt den früheren Eintrag.
- **`.spect`**: C#-Spektrum mit `Name`, `Wavelengths`, `Intensities` und optionalen Metadaten. Es wird als gespeicherte Aufnahme geladen. Aufnahmen lassen sich ausblenden, umbenennen, färben, entfernen und wieder als `.spect` exportieren.
- **`SensorConfig.json`**: C#-Polynome `LambdaMap`, `IntensityScaling`, `IntensityOffset`, Dunkelbild und Aufnahmeeinstellungen. C#-Zeitwerte werden aus 2-MHz-Ticks in µs umgerechnet. Die älteren C#-Defaults SH=10 und ICG=7400 entsprechen nur 5 beziehungsweise 3700 µs; diese Werte müssen vor Start der Web-Messung auf gültige Zeiten gesetzt werden. Die Web-App erhält beim Import die Werte und meldet ungültige Einstellungen beim Messstart.

Einzelne Bibliotheksdateien dürfen bis zu 64 MB groß sein. Dateien mit fehlenden, unterschiedlich langen oder nicht endlichen Datenreihen werden mit sichtbarer Fehlermeldung abgewiesen. Wellenlängen werden sortiert; doppelte Wellenlängen werden mit der jeweils höchsten Intensität zusammengeführt. Bereits serialisierte `IntensitiesNormalized`-Caches aus C# werden ignoriert und neu berechnet.

Die Referenzkurven werden auf ihr eigenes Maximum normiert und über die rechte Referenzskala dargestellt. Mehrere Spezies können gleichzeitig sichtbar sein. Das Matching interpoliert Referenzen linear auf das Raster der aktuellen Messung; außerhalb des Referenzrasters wird null verwendet.

### Verarbeitung und Kalibrierung

**Peak intensity** enthält zusätzlich die Aussteuerung des 12-Bit-ADCs: `höchster übertragener ADC-Wert / 4095 × 100 % FS` sowie den tatsächlichen Spitzenwert in Counts. Die Kennzahl wird vor Dunkelbildkorrektur, Intensitätskalibrierung, Gruppenmittelung und Normalisierung bestimmt. Ein auf 1 normierter Peak kann deshalb gleichzeitig nur 0,10 % FS entsprechen.

- Unter **5 % FS**: niedriger Pegel / möglicherweise zu dunkel.
- Ab **95 % FS**: nahe der Sättigung; Signal oder Integrationszeit reduzieren.
- Bereits **ein Sample bei 4095**: roter Fehler **ADC SATURATED**, mit Anzahl der betroffenen Samples, rotem Rahmen um Peak-Karte und Plot sowie Fehlerbanner. Die Messung läuft zur Diagnose weiter; der Fehler verschwindet beim nächsten gültigen, nicht gesättigten Frame.
- Samples außerhalb **0–4095**: separater roter Fehler **INVALID ADC DATA**. Daraus wird keine gültige Aussteuerung abgeleitet.

5 % und 95 % sind Orientierungsschwellen für die ADC-Aussteuerung, keine Messung der optischen Helligkeit oder des Signal-Rausch-Abstands. Alle 3694 übertragenen Samples einschließlich Dummy-Pixeln werden berücksichtigt. Bei aktivierter Firmware-Mittelwertbildung können gesättigte Einzelintegrationen im gemittelten Ergebnis verborgen bleiben; die App weist darauf hin. Für einen unvermittelten Sättigungstest Averaging auf **1** setzen.

ADC-Statistiken werden unter `Metadata.adc` mit Captures gespeichert. Ältere `.spect`-Dateien, Referenzen und Demo-Kurven ohne Rohdatenstatistik zeigen **ADC —**; aus normierten Intensitäten wird keine Aussteuerung geschätzt.

- Die pixelweise Dunkelbildkorrektur verwendet die letzte vollständige **Rohaufnahme** und schneidet negative Rohdifferenzen auf null ab.
- Wellenlängen werden mit einem kubischen Polynom aus Detektorpixel 0–3693 berechnet. Der Kalibrierdialog erlaubt direkte Koeffizienten oder eine lineare, quadratische beziehungsweise kubische Anpassung aus Pixel-/Wellenlängenpaaren. Für den Fit werden QR-Zerlegung sowie zentrierte und skalierte Pixelwerte verwendet; der RMS-Fehler wird angezeigt. Die Zuordnung muss über den gesamten Detektor streng monoton sein. Eine absteigende Zuordnung wird sortiert dargestellt; ein umkehrendes oder konstantes Polynom wird abgewiesen.
- Die Intensitätskorrektur folgt dem C#-Modell: `((raw - min(raw, dark)) / 65535) * scale(λ) + offset(λ)`. Bei Anzeige in ADC-Counts wird das Ergebnis mit 65535 multipliziert. **Normalize intensity** normiert anschließend auf das Maximum. Das ADC-Wireformat bleibt 16 Bit; diese Skalierung ist keine physikalische Intensitätskalibrierung.
- Eine einstellbare Gruppenmittelung reduziert die Plotauflösung, ohne Restpixel am Ende zu verwerfen. Gespeicherte Aufnahmen bewahren ihre zum Speicherzeitpunkt verarbeiteten Werte; spätere Kalibrieränderungen rechnen sie nicht rückwirkend um.
- Konfiguration und Dunkelbild können im Kalibrierdialog importiert/exportiert werden. Der Export enthält sowohl Web-Einstellungen als auch die C#-Felder.

### Kalibrierassistent

**Kalibrierassistent** ist direkt in der Seitenleiste und im Kalibrierdialog verfügbar. Er führt durch den gesamten Ablauf:

1. **Sensor-Eingang vollständig abdecken**, dann ausdrücklich bestätigen. Die App nimmt standardmäßig **32 vollständige Einzelbilder** auf; wählbar sind 16, 32, 64 oder 128. Ein Fortschrittsbalken zeigt die bereits empfangenen Bilder und den Prozentwert. Der Mittelwert bleibt als Dunkelbild mit Nachkommastellen erhalten.
2. **Bekanntes Spektrum anlegen**, einen Referenznamen vergeben und bestätigen. Es werden erneut gleich viele Einzelbilder aufgenommen. SH und ICG bleiben für Dunkelbild und alle Referenzen identisch; die Firmware-Mittelung ist für diese Aufnahmen ausgeschaltet. Die App mittelt selbst und prüft dabei jedes Einzelbild auf Sättigung und ungültige ADC-Werte.
3. Der Assistent zeigt das dunkelbildkorrigierte **Emission spectrum in ursprünglichen Detektorpixeln 0–3693**. Die vorhandene Wellenlängenkalibrierung und die normale Plot-Gruppenmittelung werden dabei nicht verwendet. Peak anklicken, bekannte Wellenlänge in nm eingeben, **Zuordnung hinzufügen**. Alternativ lässt sich die Pixelposition direkt eingeben, auch mit Nachkommastellen. Mausrad, Verschieben und Einpassen funktionieren im Assistentenplot ebenfalls.
4. Nach beliebig vielen Linien mit **Zuordnungen korrekt · Übernehmen** diese Referenz bestätigen. **Weitere Referenz** wiederholt Aufnahme und Zuordnung für eine andere Lichtquelle. Bereits bestätigte Referenzen bleiben erhalten und können bearbeitet oder entfernt werden. Eine erneute Aufnahme einer bereits bestätigten Referenz ersetzt sie nach erneuter Bestätigung.
5. Der Fit verwendet gemeinsam alle bestätigten Pixel-/Wellenlängenpaare. Standardmäßig wird automatisch linear bei zwei, quadratisch bei drei und kubisch ab vier verschiedenen Pixelpositionen angepasst. Der Grad ist auch manuell wählbar. Die Übersicht zeigt Koeffizienten, RMS der Zuordnungsfehler und die Abweichung jeder einzelnen Linie. RMS ist ein Fit-Residuum und keine Aussage über die absolute Messunsicherheit. Außerhalb der zugeordneten Pixelpositionen wird extrapoliert.
6. **Fertig · Kalibrierung anwenden** übernimmt Polynom und gemitteltes Dunkelbild gemeinsam. Die zuletzt gemittelte Referenz erscheint anschließend mit der neuen Wellenlängenachse im Hauptplot. Der Assistent speichert auch Referenzaufnahmen und Zuordnungen lokal; die Zuordnungen sind danach im bestehenden manuellen Fit-Bereich sichtbar, auch nach einem Reload. Eine neue Assistentensitzung beginnt mit einem neuen Dunkelbild.

Eine laufende Live-Messung wird beim Öffnen zunächst nach dem laufenden Frame pausiert. Ein wartender externer Trigger wird durch Trennen und erneutes Identifizieren desselben Ports beendet. Falls noch kein Gerät verbunden ist, lässt es sich direkt im Assistenten verbinden. Während der Assistent arbeitet, werden ausschließlich seine eigenen Aufnahmen angefordert; der normale Triggerbetrieb wird dabei nicht aktiviert. Nach dem Assistenten lässt sich die reguläre Messung mit **Start acquisition** beziehungsweise **Arm trigger** fortsetzen.

Mindestens zwei verschiedene Pixelpositionen sind nötig. Widersprüchliche Wellenlängen am selben Pixel sowie Polynome, die innerhalb des Detektors umkehren, werden vor der Übernahme abgewiesen. Gesättigte Referenz- oder Dunkelaufnahmen werden nicht gemittelt übernommen und lassen sich wiederholen. Bei Abbruch während einer Aufnahme wird der Port geschlossen, damit kein Teilframe in eine spätere Messung gerät. Die zuvor angewendete Kalibrierung wird erst nach erfolgreichem **Fertig** ersetzt.

Der Web-Konfigurationsexport enthält das gemittelte Dunkelbild mit Nachkommastellen unter `darkFrame`; das zusätzliche C#-Feld `DarkFrame` enthält gerundete Ganzzahlen für die Kompatibilität mit dem bisherigen C#-Tool. Beim erneuten Web-Import wird die präzise Variante bevorzugt.

### Matching

Alle Kurven werden für das Matching separat auf ihr Maximum normiert. Die drei C#-Methoden sind übernommen:

| Methode | Formel (Summe über alle Samples) |
|---|---|
| SquaresSum | `100 * (1 - Σ(reference - sample)² / Σreference²)` |
| SquaresSumSat | `100 * (1 - Σmax(0, reference - sample)² / Σreference²)` |
| Multiply | `100 * Σ(sample * reference) / Σsample²` |
| Cosine | `100 * Σ(sample * reference) / sqrt(Σsample² * Σreference²)` |

Die ersten drei Methoden können negative Werte beziehungsweise Werte über 100 liefern; die Zahlen werden nicht künstlich auf einen Wahrscheinlichkeitsbereich begrenzt. Leere/energielose Referenzen liefern keinen Score. Scores beschreiben Kurvenähnlichkeit, **keine Identifikationswahrscheinlichkeit oder Elementkonzentration**. Gespeicherte Aufnahmen werden ebenfalls verglichen. Mit **Match** lässt sich der Vergleich unabhängig vom Trigger jederzeit ausführen.

## Plot und Export

- Mausrad: um die Cursorposition zoomen; Ziehen: verschieben; Shift + Ziehen: Wellenlängenbereich auswählen.
- Doppelklick, **Fit** oder Taste **F**: sichtbare Daten vollständig einpassen. Plus/Minus funktionieren auch bei fokussiertem Plot.
- Cursor: genaue Wellenlänge und Intensität. **Peaks** schaltet lokale Maxima samt Beschriftung ein/aus.
- **Save capture** oder Taste **S**: aktuelle Kurve speichern. **CSV** exportiert die angezeigten Werte, **PNG** den aktuellen Plot.
- Referenzen, Captures, Kalibrierung und Dunkelbild bleiben über IndexedDB in diesem Browser/Origin erhalten. Die laufende Messung wird erst mit **Save capture** dauerhaft gespeichert. Ein anderer Host/Port hat einen separaten Speicher; zum Übertragen Export verwenden.

Beim ersten Start wird ein deutlich markiertes **synthetisches Demo** angezeigt. Die Kurven sind keine NIST-Daten und keine Messungen. Das Importieren echter Referenzen/Aufnahmen oder der erste Hardwareframe entfernt die Demo-Referenzen. **Explore demo** lädt die Demo erneut und erhält vorhandene Benutzerdateien. Es gibt bewusst keinen NIST-Fetcher und keine Netzwerkanfragen an NIST.

## Entwicklung und Prüfungen

Node ≥20 genügt. `npm install` ist nicht erforderlich.

```powershell
npm test
```

Falls Windows das Erzeugen von Test-Workerprozessen mit `spawn EPERM` verhindert:

```powershell
node --test --test-isolation=none
```

Die Tests prüfen das echte Encoding/Decoding, fragmentierte Web-Serial-Streams mit Mock-Geräten, Triggerabbruch, Verbindungsverlust, C#-Dateiformate, Korrekturen, Interpolation, Matching und Polynomanpassung. Sie ersetzen keinen elektrischen Test am STM32/CCD.

### Dateien

| Datei | Aufgabe |
|---|---|
| `app.js` | UI, Messablauf, Import/Export und Workspace |
| `protocol.js` | Befehle, exakte Byte-Empfangslogik, Web Serial und Verbindungszustände |
| `device-info.js` | Darstellung von Firmwareversion, Buildzeit und Git-Provenienz |
| `data.js` | Formate, Korrekturen, Referenzinterpolation, Matching, Kalibrierung |
| `adc.js` | Aussteuerung des 12-Bit-ADCs, Sättigung und Prüfung gespeicherter ADC-Statistiken |
| `calibration.js` | Präzise Mittelung, Dunkelbildkorrektur und gemeinsamer Pixel-/Wellenlängenfit |
| `calibration-wizard.js` | Geführte Aufnahme, Fortschritt, Peak-Zuordnungen und Prüfung vor der Übernahme |
| `plot.js` | Canvas-Spektralplot, Cursor, Zoom, Peak-Markierungen und Sparklines |
| `storage.js` | Lokale IndexedDB-Speicherung |
| `server.mjs` | Optionaler statischer Entwicklungsserver |
