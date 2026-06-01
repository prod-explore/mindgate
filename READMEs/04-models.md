# Modele — konfiguracja Ollama

MindGate nie narzuca konkretnych modeli. Definiujesz 5 profili i mapujesz je na dowolne modele dostępne w Ollama. Ta strona pomaga wybrać sensowne modele na start i zrozumieć jak je dobierać.

---

## Profile a modele — różnica

**Profil** to semantyczna etykieta którą podaje klient (`model: "reasoning"`). Jest stabilna — klient zawsze prosi o "reasoning" bez względu na to który model aktualnie za tym stoi.

**Model** to konkretna wersja w Ollama (`qwq:32b`, `llama3.3:70b`). Możesz go zmieniać w `config/models.yml` bez dotykania klientów.

---

## Polecane modele na start

### Masz 8GB VRAM

```yaml
models:
  flash:
    ollama: "qwen2.5:3b"
  reasoning:
    ollama: "qwen2.5:7b-instruct-q4_K_M"
  coding-fast:
    ollama: "qwen2.5-coder:3b"
  coding-hard:
    ollama: "qwen2.5-coder:7b-instruct-q4_K_M"
  extreme:
    ollama: "llama3.1:8b-instruct-q8_0"
```

### Masz 16GB VRAM

```yaml
models:
  flash:
    ollama: "qwen2.5:3b"
  reasoning:
    ollama: "qwq:32b-preview-q4_K_M"
  coding-fast:
    ollama: "qwen2.5-coder:7b"
  coding-hard:
    ollama: "qwen2.5-coder:32b-instruct-q4_K_M"
  extreme:
    ollama: "llama3.3:70b-instruct-q2_K"
```

### Masz 24GB VRAM

```yaml
models:
  flash:
    ollama: "qwen2.5:3b"
  reasoning:
    ollama: "qwq:32b-q8_0"
  coding-fast:
    ollama: "qwen2.5-coder:7b"
  coding-hard:
    ollama: "qwen2.5-coder:32b-instruct-q8_0"
  extreme:
    ollama: "llama3.3:70b-instruct-q4_K_M"
```

---

## Skrótowy przewodnik po modelach

### Flash — szybki, lekki

Zadania: formatowanie odpowiedzi, podsumowania, proste pytania, autouzupełnianie, chat.

Dobre wybory:
- `qwen2.5:3b` — bardzo szybki, zaskakująco dobry jak na rozmiar
- `qwen2.5:1.5b` — jeśli potrzebujesz absolutnego minimum latencji
- `phi3.5:3.8b` — dobry do prostego rozumowania

### Reasoning — głębokie myślenie

Zadania: analiza, planowanie projektów, matematyka, logika, wyciąganie wniosków z dokumentów.

Dobre wybory:
- `qwq:32b` — model z chain-of-thought, jawnie "myśli" przed odpowiedzią
- `deepseek-r1:32b` — alternatywny reasoning model
- `qwen2.5:32b` — jeśli nie masz na duże reasoning modele

### Coding Fast — szybkie kodowanie

Zadania: autouzupełnianie, małe poprawki, generowanie snippetów, wyjaśnianie kodu.

Dobre wybory:
- `qwen2.5-coder:7b` — jeden z najlepszych małych modeli do kodu
- `qwen2.5-coder:3b` — jeśli potrzebujesz jeszcze szybciej
- `codellama:7b` — klasyk, dobry do wielu języków

### Coding Hard — poważne kodowanie

Zadania: architektura systemu, refactoring, trudne algorytmy, code review, debugowanie.

Dobre wybory:
- `qwen2.5-coder:32b` — state of the art dla lokalnych modeli coding
- `deepseek-coder-v2:16b` — dobra alternatywa
- `codestral:22b` — od Mistral, świetny do kodu

### Extreme — maksimum możliwości

Zadania: wszystko co wymaga najlepszej jakości bez ograniczeń czasowych. Długie dokumenty, skomplikowane analizy, kreatywne projekty.

Dobre wybory:
- `llama3.3:70b` — Meta's flagship, wszechstronny
- `qwen2.5:72b` — Alibaba's biggest, bardzo dobry
- `mixtral:8x22b` — mixture of experts, dobry stosunek jakości do prędkości

---

## Kwantyzacja — co oznaczają Q4, Q8

Modele są kompresowane przez kwantyzację — zmniejsza to zużycie VRAM kosztem minimalnej utraty jakości.

| Kwantyzacja | VRAM | Jakość | Kiedy używać |
|-------------|------|--------|--------------|
| `q2_K` | ~25% full | słabsza | tylko gdy nie mieści się nic innego |
| `q4_K_M` | ~45% full | dobra | domyślny wybór, dobry balans |
| `q5_K_M` | ~55% full | lepsza | jeśli masz zapas VRAM |
| `q8_0` | ~80% full | bardzo dobra | blisko full precision |
| (brak) | 100% | pełna | rzadko potrzebne lokalnie |

Przykład: `qwq:32b-q4_K_M` to model QwQ 32B skwantyzowany do Q4_K_M — zajmuje ~18GB VRAM.

---

## Pobieranie modeli

```bash
# Pobierz model
ollama pull qwen2.5:3b
ollama pull qwq:32b-preview-q4_K_M
ollama pull qwen2.5-coder:7b

# Lista pobranych
ollama list

# Usuń model (zwalnia dysk)
ollama rm qwen2.5:3b

# Informacje o modelu
ollama show qwen2.5:3b
```

---

## Sprawdzanie wydajności

Po pobraniu modelu sprawdź jego prędkość:

```bash
# Benchmark — tokens per second
ollama run qwen2.5:7b "Napisz Hello World w 5 językach programowania"
```

Obserwuj `eval rate` w outputcie — to tokeny/sekundę. Dla rozsądnego UX:
- Flash: > 30 t/s
- Reasoning/Coding: > 10 t/s  
- Extreme: > 3 t/s (akceptowalne dla ważnych zadań)

---

## Własny Modelfile (zaawansowane)

Możesz dostosować system prompt dla profilu tworząc własny Modelfile:

```
FROM qwen2.5:7b

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
ollama create mindgate-reasoning -f Modelfile
```

Następnie w `models.yml`:

```yaml
models:
  reasoning:
    ollama: "mindgate-reasoning"
```
