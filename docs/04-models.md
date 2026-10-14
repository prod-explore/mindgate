# Modele — Ollama i zarządzanie z huba

Modelami na maszynie z GPU zarządza się **z huba**. Nie ma pliku z listą modeli ani „profili” zaszytych w agencie: to, co jest zainstalowane, pokazuje maszyna, a nazwy, pod którymi modele widzą klienci, to **aliasy** w hubie. Ta strona mówi, jak pobierać i usuwać modele, ile ich się zmieści i jak postępować z modelami bez cenzury.

---

## Jak to działa

- **Model** to rzecz zainstalowana w Ollamie (`qwen3:4b`). W hubie ma identyfikator `dostawca/model`, np. `pc/qwen3:4b`.
- **Alias** to nazwa dla klientów (`flash`, `smart`) z listą modeli w kolejności fallbacku. Zmieniasz, co się za nią kryje, bez ruszania klientów.
- **Maszyna** zgłasza hubowi, co potrafi każdy model (narzędzia, obrazy, „myślenie”, realny kontekst, czy to embedding), a hub to zapamiętuje. Ręczne poprawki (nazwa, tagi, kontekst) mają pierwszeństwo i przeżywają synchronizację.

Zmiana modelu = pobranie nowego, przestawienie aliasu. Klienci nie wiedzą o niczym.

---

## Zarządzanie modelami z huba

Wszystko poniżej jest też w API ([08 - API](08-api.md)); [panel](09-panel.md) pokazuje to samo (ekran „Węzły” dla maszyn, „Modele” i „Aliasy” dla katalogu). Zamieniasz `pc` na identyfikator swojego dostawcy.

```bash
H=http://localhost:3000/admin/api ; A="Authorization: Bearer $MINDGATE_ADMIN_TOKEN"

# co jest na maszynie (z rozmiarem, kwantyzacją, możliwościami, czy jest w pamięci karty)
curl -H "$A" $H/providers/pc/node/models

# pobierz model (w tle; odpowiedź to zadanie z id)
curl -X POST -H "$A" -H 'Content-Type: application/json' -d '{"name":"qwen3:4b"}' $H/providers/pc/node/pulls

# postęp
curl -H "$A" $H/providers/pc/node/pulls

# przerwij
curl -X DELETE -H "$A" $H/providers/pc/node/pulls/<id>

# usuń z dysku (i z katalogu huba)
curl -X DELETE -H "$A" $H/providers/pc/node/models/qwen3:4b

# załaduj do karty z góry (żeby pierwsze żądanie nie czekało) / zwolnij kartę
curl -X POST -H "$A" -H 'Content-Type: application/json' -d '{"name":"qwen3:4b","keep_alive":"30m"}' $H/providers/pc/node/models/load
curl -X POST -H "$A" -H 'Content-Type: application/json' -d '{"name":"qwen3:4b"}' $H/providers/pc/node/models/unload
```

Gdy pobieranie się skończy, **model sam pojawia się w katalogu huba** (włączony i oznaczony jako lokalny) — nie trzeba niczego synchronizować. Maszyna musi być włączona; hub **nie budzi** jej przy zarządzaniu modelami (`POST …/wake`, gdy chcesz ją obudzić).

Nazwa modelu może być też wszystkim, co rozumie Ollama: `hf.co/użytkownik/repo:Q4_K_M` (model z Hugging Face w formacie GGUF), zobacz niżej.

Aliasy:

```bash
curl -X POST -H "$A" -H 'Content-Type: application/json' $H/aliases -d '{
  "name": "flash",
  "description": "szybkie odpowiedzi",
  "targets": ["pc/qwen3:4b", "openrouter/google/gemini-2.0-flash-001"]
}'
```

Pierwszy cel jest lokalny, drugi to jawny fallback w chmurze (klucz z `local_only` go pominie). Model zainstalowany ręcznie na maszynie (`ollama pull` w terminalu, `ollama create`) pojawi się w hubie przy następnej synchronizacji (`POST …/providers/pc/sync`, albo automatycznie po starcie i raz na dobę).

---

## Co się zmieści

Reguła kciuka dla kwantyzacji Q4_K_M: **około 0,6 GB na miliard parametrów**, do tego pamięć kontekstu (kilkaset MB przy 8k tokenów) i narzut ~0,5 GB. To rzędy wielkości, nie obietnice — `ollama ps` pokazuje, jak model naprawdę się ułożył (kolumna `PROCESSOR`: ile na GPU, ile na CPU).

Gdy model nie mieści się na karcie, Ollama przenosi część warstw do RAM-u. Działa, ale wolniej: im większa część poza kartą, tym bliżej prędkości samego procesora.

Przykład sprzętu: **4 GB VRAM + 16 GB RAM**

| Rozmiar (Q4_K_M) | Gdzie liczy się model | Czego się spodziewać |
|---|---|---|
| 1–4B (≈ 1–2,8 GB) | cały na karcie | szybko; to jest codzienny model |
| 7–8B (≈ 4,5–5 GB) | większość na karcie, reszta w RAM | zauważalnie wolniej, ale używalnie |
| 12–14B (≈ 8–9 GB) | głównie w RAM | wolno (kilka tokenów/s); do zadań, w których można poczekać |
| 20–32B (≈ 12–19 GB) | nie mieści się sensownie w 16 GB RAM | nie warto |
| 70B+ | nie | — |

Duże modele (32B, 70B) wymagają karty z 24 GB VRAM i więcej albo kilku kart; na słabszym sprzęcie lepiej wziąć mniejszy model albo skierować te zapytania do chmury aliasem z fallbackiem.

### Ustawienia Ollamy, które pomagają na małej karcie

W `agent/.env` (agent przekaże je Ollamie, którą sam uruchamia):

```
OLLAMA_CONTEXT_LENGTH=8192     # mniejszy kontekst = mniej pamięci na cache; agent zgłosi hubowi tę wartość
OLLAMA_MAX_LOADED_MODELS=1     # jeden model naraz
OLLAMA_NUM_PARALLEL=1          # jedno żądanie naraz; kolejkę i tak prowadzi hub (max_concurrency)
OLLAMA_KEEP_ALIVE=5m           # model schodzi z karty po 5 minutach bez użycia
```

---

## Propozycje na start

Biblioteka Ollamy (`ollama.com/library`) zmienia się szybko; to są nazwy, które działają w chwili pisania, jako punkt wyjścia.

| Do czego | Przykład | Uwagi |
|---|---|---|
| ogólny, szybki | `qwen3:4b`, `llama3.2:3b`, `phi4-mini` | mieszczą się na 4 GB; `qwen3` ma tryb „myślenia” i narzędzia |
| obrazy | `gemma3:4b` | rozumie obrazy; hub zobaczy `vision` |
| kod | `qwen2.5-coder:3b`, `qwen2.5-coder:7b` | 7B będzie częściowo w RAM na 4 GB |
| embeddingi | `nomic-embed-text` | hub rozpozna typ `embedding` |
| więcej miejsca (8–12 GB VRAM) | `qwen3:8b`, `qwen3:14b` | |

Po pobraniu sprawdź prędkość: `ollama run <model> --verbose "Napisz Hello World w 5 językach"` i spójrz na `eval rate` (tokeny na sekundę). Dla rozsądnego UX: > 30 t/s do prostych rzeczy, > 10 t/s do kodu i analizy, > 3 t/s do zadań, w których można poczekać.

---

## Kwantyzacja — co oznaczają Q4, Q8

Model skompresowany do mniejszej liczby bitów zajmuje mniej pamięci kosztem niewielkiej utraty jakości.

| Kwantyzacja | Rozmiar względem pełnego | Jakość | Kiedy |
|---|---|---|---|
| `q2_K` | ~25% | wyraźnie słabsza | tylko gdy nic innego się nie mieści |
| `q4_K_M` | ~45% | dobra | **domyślny wybór** |
| `q5_K_M` | ~55% | lepsza | gdy masz zapas pamięci |
| `q8_0` | ~80% | bardzo dobra | blisko pełnej precyzji |

Tag w nazwie to wybiera: `qwen3:4b-q8_0`.

---

## Modele bez cenzury (uncensored / abliterated)

Chodzi o modele z usuniętymi lub osłabionymi zabezpieczeniami odmawiania odpowiedzi. MindGate traktuje je tak, jak powinno się je traktować — **tylko lokalnie**:

1. Model pobiera się z Hugging Face przez Ollamę — to samo polecenie pobierania, tylko nazwa ma postać `hf.co/<użytkownik>/<repozytorium>:<kwantyzacja>`:

   ```bash
   curl -X POST -H "$A" -H 'Content-Type: application/json' $H/providers/pc/node/pulls \
     -d '{"name":"hf.co/bartowski/gemma-2-2b-it-abliterated-GGUF:Q4_K_M"}'
   ```

   (Repozytorium musi mieć pliki GGUF; dostępne kwantyzacje zobaczysz na jego stronie. Wybieraj autorów, którym ufasz — to wykonywalna wiedza, ale plik pochodzi z internetu.)

2. Agent oznacza taki model tagiem **`uncensored`**, jeśli nazwa zawiera „abliterated” lub „uncensored”. Dla innych nazw dodaj tag ręcznie: `PATCH /admin/api/models/pc/<nazwa> {"tags":["uncensored"]}`.
3. Model leży na Twojej maszynie, więc jego `locality` to `local`: żądanie do niego nie wychodzi do chmury, a klucz z `local_only` może go użyć bez ograniczeń.
4. **Nie podłączaj takiego modelu do aliasu z celem w chmurze**, jeśli nie chcesz, żeby te same pytania trafiały do dostawcy chmurowego po awarii maszyny. Alias tylko z lokalnymi celami (`"targets": ["pc/…-abliterated"]`) przy awarii po prostu zwróci błąd, nie wyśle pytania nigdzie indziej.
5. Takie modele bywają mniej spójne niż oryginały (usunięcie odmów nie jest darmowe). Sprawdź na swoich zadaniach.

Odpowiedzialność za to, co taki model wygeneruje i do czego go użyjesz, jest po Twojej stronie.

---

## Własny Modelfile (zaawansowane)

Możesz stworzyć wariant modelu z własnym promptem systemowym lub parametrami — na maszynie:

```
FROM qwen3:4b

SYSTEM """
Jesteś precyzyjnym asystentem analitycznym. Zawsze:
- Analizujesz problem zanim odpiszesz
- Podajesz konkretne, weryfikowalne informacje
- Zaznaczasz gdy czegoś nie jesteś pewien
"""

PARAMETER temperature 0.3
PARAMETER top_p 0.9
```

```bash
ollama create analityk -f Modelfile
```

Po synchronizacji huba (`POST /admin/api/providers/pc/sync`) pojawi się jako `pc/analityk:latest` i możesz wskazać go z aliasu.
