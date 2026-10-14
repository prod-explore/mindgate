# Panel administracyjny

Panel to strona, przez którą zarządzasz hubem bez `curl`: dostawcy, modele, aliasy, klucze klientów, zużycie, log żądań i modele na maszynach z GPU. Robi dokładnie to, co [API administratora](08-api.md) — nie ma żadnej własnej ścieżki do bazy.

- **Adres:** `http://<hub>:3000/admin/` (`/admin` przekierowuje na `/admin/`).
- **Logowanie:** wartość `MINDGATE_ADMIN_TOKEN` z środowiska huba. To ten sam token, który chroni `/admin/api`.
- **Języki:** polski i angielski (domyślnie wg przeglądarki), motyw jasny / ciemny / automatyczny. Oba wybory zapamiętuje przeglądarka.

## Uruchomienie

**Docker** — obraz zawiera hub i zbudowany panel; nic więcej nie trzeba robić. Zmieniło się tylko to, skąd obraz jest budowany: **kontekstem jest katalog główny repozytorium**, bo do obrazu trafia też `panel/`. `docker compose up -d --build` w `gate/` robi to samo co dotąd (plik `docker-compose.yml` ma już `context: ..`). Ręcznie:

```bash
docker build -f gate/Dockerfile -t mindgate-hub .      # z katalogu głównego repozytorium
```

**Bez Dockera** — panel trzeba zbudować raz; hub znajdzie go w `panel/dist`:

```bash
cd panel
npm ci
npm run build          # sprawdza typy i buduje do panel/dist
cd ../gate && npm start
```

Katalog z panelem wskazuje `MINDGATE_PANEL_DIR`:

| Wartość | Efekt |
|---|---|
| nie ustawiona | `panel/dist` obok `gate/` (z checkoutu), w obrazie `/app/panel` |
| ścieżka | panel z tego katalogu |
| pusta (`MINDGATE_PANEL_DIR=`) | panel wyłączony, zostaje samo API |

Gdy katalog nie zawiera zbudowanego panelu (brak `index.html`), hub **startuje normalnie**, a w logu ostrzega: `the admin panel is not built there … /admin/ is off`. `/admin/` odpowiada wtedy `404`, API działa.

## Logowanie i token

Token wpisujesz raz na ekranie logowania; panel od razu sprawdza go w hubie (`GET /admin/api/status`), więc zły token widać od razu.

- Domyślnie token żyje **tylko w tej karcie** (`sessionStorage`) — zamknięcie karty wylogowuje.
- „Zostaw mnie zalogowanego na tym urządzeniu” zapisuje go w `localStorage`. Nie włączaj tego na cudzym komputerze.
- Hub odrzucił token (zmieniony, wyczyszczony)? Panel wraca do logowania z komunikatem. „Wyloguj” w menu usuwa token z obu miejsc.
- Token jest wysyłany wyłącznie do `/admin/api` tego samego adresu, w nagłówku `Authorization`. Pliki panelu są publiczne i **nie zawierają żadnych sekretów** — sam adres `/admin/` nic nie ujawnia, wszystko, co widać po zalogowaniu, pochodzi z API.
- Klucze dostawców nie wracają z API nigdy (widać tylko ostatnie znaki). Pełny klucz klienta pokazuje się **raz**, w oknie po utworzeniu — potem nie da się go odczytać.

## Ekrany

| Menu | Co tam jest |
|---|---|
| **Przegląd** | stan dostawców (online / śpi / budzi się, kolejka „trwa / czeka”, ostatni problem), liczby z dzisiaj (żądania, tokeny, błędy, udział tokenów na Twoim sprzęcie), wykres 14 dni, ostatnie błędy |
| **Dostawcy** | dodawanie z gotowych wpisów (OpenRouter, Gemini, Anthropic, maszyna z agentem…), edycja, test połączenia, synchronizacja listy modeli, włączanie / wyłączanie, budzenie maszyny, usuwanie (z listą aliasów, które straciły model) |
| **Węzły** | maszyny z agentem: połączenie, sprzęt (CPU, RAM, GPU, dysk), modele w pamięci GPU, zainstalowane modele z oceną, czy zmieszczą się w VRAM, pobieranie z postępem i anulowaniem, ładowanie / zwalnianie / usuwanie, wyłączenie z przyczyną odmowy |
| **Modele** | wszystko, co hub może obsłużyć: wyszukiwanie i filtry (dostawca, rodzaj, gdzie działa, stan, tag), włączanie pojedynczo i masowo, edycja nazwy / tagów / kontekstu / możliwości, ręczne dodawanie modelu |
| **Aliasy** | uporządkowana lista modeli pod jedną nazwą — jedyne miejsce, gdzie działa fallback; od razu widać, czy łańcuch jest w całości lokalny |
| **Klucze klientów** | tworzenie, limity (żądania na minutę / dzień, tokeny na dzień / miesiąc), zakres priorytetów, „tylko lokalnie”, dozwolone modele, zużycie względem limitów, unieważnianie i usuwanie |
| **Zużycie** | 7 / 30 / 90 dni, żądania / tokeny / błędy, rozbicie na lokalne i chmurowe, tabele per model i per klucz; filtry klucza i modelu działają w przeglądarce, bez ponownego pobierania |
| **Log żądań** | kto, jaki model, jak poszło, ile trwało; szczegóły jednego żądania; „Wczytaj starsze”; samoodświeżanie co 5 s (można wyłączyć). Nigdy treść promptów ani odpowiedzi — tak jak w hubie |

Adres strony niesie stan widoku (`#/usage?days=7&metric=tokens`, `#/log?errors=1&key=…`, `#/models?q=qwen&state=off`), więc widok można wkleić komuś lub wrócić do niego przyciskiem „wstecz”.

### Maszyny z agentem

Panel **nigdy nie budzi maszyny sam**. Śpiąca maszyna jest pokazana jako śpiąca, a jej ekran modeli nie odpytuje agenta, dopóki jej nie obudzisz przyciskiem „Obudź” — tak samo jak w hubie ([05 - Węzły](05-nodes.md)). Odmowa wyłączenia (ktoś pracuje, trwa pobieranie, żądania w toku…) jest pokazywana z przyczyną; „Wyłącz mimo to” jest osobnym, potwierdzanym krokiem.

## Bezpieczeństwo

Hub podaje pliki panelu tylko metodami `GET` i `HEAD`, z własnego katalogu: ścieżki z `..`, ukryte pliki (`.env`, `.git`), katalogi i dowiązania wychodzące poza katalog panelu są odrzucane (`404`). Strona dostaje restrykcyjną politykę treści:

```
default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:;
connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

czyli: żadnych zewnętrznych skryptów, czcionek ani połączeń (panel nie ładuje niczego z internetu — czcionki są w paczce), żadnych skryptów w treści strony, brak osadzania w ramce. Pliki w `assets/` mają w nazwie skrót zawartości i są cache'owane „na zawsze”; sama strona (`index.html`) nie — po aktualizacji huba przeglądarka od razu bierze nową wersję.

Pamiętaj o dwóch rzeczach, które nie zależą od panelu:

- Token administratora przechodzi w nagłówku, więc poza siecią domową używaj **HTTPS** (nginx / Caddy przed hubem, `MINDGATE_TRUST_PROXY=true`).
- `/admin` (razem z panelem) nie musi być widoczne z internetu — w nginx możesz je ograniczyć do sieci lokalnej, jak opisano w [01 - Hub](01-gate.md).

## Rozwój panelu

Panel to Vite + React + TypeScript w `panel/`, bez zewnętrznych usług w czasie działania.

```bash
cd gate && npm run dev                 # hub na :3000
cd panel && npm ci && npm run dev      # panel na http://localhost:5173/admin/, /admin/api idzie do huba
                                       # inny adres huba: MINDGATE_URL=http://pi.lan:3000 npm run dev
npm test                               # testy (Vitest + Testing Library)
npm run typecheck
npm run build                          # panel/dist
```

Układ: `src/api` (klient i typy odpowiedzi huba), `src/lib` (stan, zapytania, formatowanie — bez Reacta tam, gdzie się da), `src/ui` (przyciski, formularze, okna, wykresy), `src/pages` (po jednym pliku na ekran), `src/i18n` (`en.ts` jest wzorcem; `pl.ts` musi mieć te same klucze, pilnuje tego test). Dodając tekst, dodaj go w obu językach. Kolory mają znaczenie: bursztyn to „działa u Ciebie”, stalowy błękit to „działa u dostawcy”, zieleń / żółć / czerwień to stan — nie używaj ich do ozdoby.

## Problemy

**`/admin/` odpowiada 404, a API działa** — panel nie jest zbudowany (patrz ostrzeżenie w logu huba) albo `MINDGATE_PANEL_DIR` jest puste. Zbuduj `panel/` albo użyj obrazu Dockera.

**Panel prosi o logowanie po każdym zamknięciu karty** — tak ma być; zaznacz „Zostaw mnie zalogowanego na tym urządzeniu”.

**Panel wraca do logowania sam** — hub odrzucił token (zmieniony `MINDGATE_ADMIN_TOKEN`). Zaloguj się nowym.

**Panel pokazuje „Hub nie odpowiada”** — przeglądarka nie dociera do huba (sieć, nginx, zły port). `GET /health` powinno działać bez tokena.

**Po `docker compose up --build` obraz się nie buduje: `COPY panel/…` nie znajduje plików** — kontekst budowania nie jest katalogiem głównym repozytorium. Używaj `docker-compose.yml` z `gate/` (ma `context: ..`) albo `docker build -f gate/Dockerfile .` z korzenia.
