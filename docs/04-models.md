# Models — Ollama and managing it from the hub

The models on the GPU machine are managed **from the hub**. There is no file with a list of models and no "profiles" baked into the agent: what is installed is shown by the machine, and clients see the models by their `provider/model` ids (tags tell them apart). This page says how to download and delete models, how many fit, and how to treat uncensored models.

---

## How it works

- A **model** is something installed in Ollama (`qwen3:4b`). In the hub it has the identifier `provider/model`, for example `pc/qwen3:4b`.
- A **tag** (`free`, `coder`, `vision`, `fast`…) is a label on a model. Apps that want "some free model" read the tags from `GET /v1/models` and choose themselves; the hub has no aliases.
- The **machine** reports to the hub what each model can do (tools, images, "thinking", the real context length, whether it is an embedding model), and the hub remembers it. Manual corrections (name, tags, context) take precedence and survive a sync.

Changing a model = downloading a new one and giving it the tags the old one had. Apps that choose by tag need no change.

---

## Managing models from the hub

Everything below is in the API too ([08 - API](08-api.md)); the [panel](09-panel.md) shows the same (the "Providers" screen for machines, "Models" for the catalogue). Replace `pc` with the identifier of your provider.

```bash
H=http://localhost:3000/admin/api ; A="Authorization: Bearer $MINDGATE_ADMIN_TOKEN"

# what is on the machine (with size, quantisation, capabilities, whether it is in the card's memory)
curl -H "$A" $H/providers/pc/node/models

# download a model (in the background; the answer is a job with an id)
curl -X POST -H "$A" -H 'Content-Type: application/json' -d '{"name":"qwen3:4b"}' $H/providers/pc/node/pulls

# progress
curl -H "$A" $H/providers/pc/node/pulls

# cancel
curl -X DELETE -H "$A" $H/providers/pc/node/pulls/<id>

# delete from the disk (and from the hub's catalogue)
curl -X DELETE -H "$A" $H/providers/pc/node/models/qwen3:4b

# load into the card in advance (so that the first request does not wait) / free the card
curl -X POST -H "$A" -H 'Content-Type: application/json' -d '{"name":"qwen3:4b","keep_alive":"30m"}' $H/providers/pc/node/models/load
curl -X POST -H "$A" -H 'Content-Type: application/json' -d '{"name":"qwen3:4b"}' $H/providers/pc/node/models/unload
```

When a download finishes, **the model appears in the hub's catalogue by itself** (enabled and marked as local) — there is nothing to sync. The machine has to be on; the hub does **not** wake it for model management (`POST …/wake` when you want to wake it).

A model name can be anything Ollama understands: `hf.co/user/repo:Q4_K_M` (a Hugging Face model in GGUF format), see below.

Tags:

```bash
curl -X PATCH -H "$A" -H 'Content-Type: application/json' $H/models/pc/qwen3:4b -d '{"tags": ["fast", "free"]}'
```

A model installed by hand on the machine (`ollama pull` in a terminal, `ollama create`) shows up in the hub at the next sync: `POST …/providers/pc/sync`, or the automatic one every `MINDGATE_SYNC_INTERVAL_HOURS` (24 by default). When the hub starts, it syncs only providers it has never synced.

---

## What fits

A rule of thumb for Q4_K_M quantisation: **about 0.6 GB per billion parameters**, plus memory for the context (a few hundred MB at 8k tokens) and an overhead of ~0.5 GB. These are orders of magnitude, not promises — `ollama ps` shows how the model really settled (the `PROCESSOR` column: how much on the GPU, how much on the CPU).

When a model does not fit on the card, Ollama moves part of the layers to RAM. It works, but slower: the larger the part outside the card, the closer to the speed of the processor alone.

An example machine: **4 GB VRAM + 16 GB RAM**

| Size (Q4_K_M) | Where the model runs | What to expect |
|---|---|---|
| 1–4B (≈ 1–2.8 GB) | entirely on the card | fast; this is the everyday model |
| 7–8B (≈ 4.5–5 GB) | mostly on the card, the rest in RAM | noticeably slower, but usable |
| 12–14B (≈ 8–9 GB) | mostly in RAM | slow (a few tokens/s); for tasks where you can wait |
| 20–32B (≈ 12–19 GB) | does not fit sensibly in 16 GB of RAM | not worth it |
| 70B+ | no | — |

Big models (32B, 70B) need a card with 24 GB of VRAM or more, or several cards; on weaker hardware it is better to take a smaller model or send those queries to a cloud model (the app chooses it).

### Ollama settings that help on a small card

In `agent/.env` (the agent hands them to the Ollama it starts):

```
OLLAMA_CONTEXT_LENGTH=8192     # a smaller context = less memory for the cache; the agent reports this value to the hub
OLLAMA_MAX_LOADED_MODELS=1     # one model at a time
OLLAMA_NUM_PARALLEL=1          # one request at a time; the hub runs the queue anyway (max_concurrency)
OLLAMA_KEEP_ALIVE=5m           # the model leaves the card after 5 minutes without use
```

---

## Suggestions to start with

Ollama's library (`ollama.com/library`) changes quickly; these are names that work at the time of writing, as a starting point.

| For | Example | Notes |
|---|---|---|
| general, fast | `qwen3:4b`, `llama3.2:3b`, `phi4-mini` | fit in 4 GB; `qwen3` has a "thinking" mode and tools |
| images | `gemma3:4b` | understands images; the hub will see `vision` |
| code | `qwen2.5-coder:3b`, `qwen2.5-coder:7b` | the 7B will be partly in RAM on 4 GB |
| embeddings | `nomic-embed-text` | the hub recognises the `embedding` type |
| more room (8–12 GB VRAM) | `qwen3:8b`, `qwen3:14b` | |

After a download check the speed: `ollama run <model> --verbose "Write Hello World in 5 languages"` and look at `eval rate` (tokens per second). For a reasonable experience: > 30 t/s for simple things, > 10 t/s for code and analysis, > 3 t/s for tasks where you can wait.

---

## Quantisation — what Q4, Q8 mean

A model compressed to fewer bits takes less memory at the cost of a small loss of quality.

| Quantisation | Size relative to full | Quality | When |
|---|---|---|---|
| `q2_K` | ~25% | clearly weaker | only when nothing else fits |
| `q4_K_M` | ~45% | good | **the default choice** |
| `q5_K_M` | ~55% | better | when you have memory to spare |
| `q8_0` | ~80% | very good | close to full precision |

The tag in the name chooses it: `qwen3:4b-q8_0`.

---

## Uncensored models (uncensored / abliterated)

These are models whose refusal safeguards were removed or weakened. MindGate treats them the way they should be treated — **locally only**:

1. The model is downloaded from Hugging Face through Ollama — the same download command, only the name has the form `hf.co/<user>/<repository>:<quantisation>`:

   ```bash
   curl -X POST -H "$A" -H 'Content-Type: application/json' $H/providers/pc/node/pulls \
     -d '{"name":"hf.co/bartowski/gemma-2-2b-it-abliterated-GGUF:Q4_K_M"}'
   ```

   (The repository must have GGUF files; you can see the available quantisations on its page. Choose authors you trust — a model is just weights, but the file comes from the internet.)

2. The agent marks such a model with the tag **`uncensored`** if its name contains "abliterated" or "uncensored". For other names add the tag by hand: `PATCH /admin/api/models/pc/<name> {"tags":["uncensored"]}`.
3. The model sits on your machine, so its `locality` is `local`: a request to it does not leave for the cloud, and a key with `local_only` can use it without restrictions.
4. **The hub never moves such a question to another model**: when the machine fails, the client gets an error. Make sure the *app* does not fall back to a cloud model for these requests (a key with `local_only` guarantees it).
5. Such models are sometimes less coherent than the originals (removing refusals is not free). Check them on your own tasks.

Responsibility for what such a model generates and for what you use it for is yours.

---

## Your own Modelfile (advanced)

You can create a variant of a model with your own system prompt or parameters — on the machine:

```
FROM qwen3:4b

SYSTEM """
You are a precise analytical assistant. Always:
- Analyse the problem before you answer
- Give concrete, verifiable information
- Say when you are not sure of something
"""

PARAMETER temperature 0.3
PARAMETER top_p 0.9
```

```bash
ollama create analyst -f Modelfile
```

After the hub syncs (`POST /admin/api/providers/pc/sync`) it appears as `pc/analyst:latest` and you can use it.
