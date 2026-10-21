# Budżet – aplikacja na telefon

Mini aplikacja do zapisywania wydatków, przychodów i transferów na bieżąco. Później
przesyła się je kodami QR do aplikacji „Budżet” na Windows.

- Działa w przeglądarce (iPhone/Safari, Android/Chrome), także offline, po dodaniu do ekranu głównego.
- **Dane zostają wyłącznie na telefonie** (IndexedDB). Strona nie łączy się z żadnym serwerem.
  Wymusza to nagłówek Content-Security-Policy w `index.html`.
- Biblioteki są wbudowane w repo (`lib/`), bez zewnętrznych CDN:
  - [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT) do rysowania kodów,
  - [jsQR](https://github.com/cozmo/jsQR) (Apache-2.0) do odczytu kodów aparatem.
