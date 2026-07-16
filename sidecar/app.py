import argparse
import logging
import os
import signal
import sys
import time
import asyncio
from contextlib import asynccontextmanager
from typing import List, Union

import torch
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer
import uvicorn

logger = logging.getLogger("sidecar")

model = None
model_name_arg = None
device_name = None
dims = None
start_time = None
loaded = False


class EmbeddingRequest(BaseModel):
    input: Union[str, List[str]]
    model: str = ""


@asynccontextmanager
async def lifespan(app: FastAPI):
    global start_time
    start_time = time.time()
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _load, model_name_arg, os.environ.get('SIDECAR_DEVICE'))
    yield
    logger.info("Shutting down sidecar")


app = FastAPI(title="embedding-sidecar", lifespan=lifespan)


@app.exception_handler(Exception)
async def global_exc_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled exception: {exc}")
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "message": str(exc),
                "type": type(exc).__name__,
                "code": 500,
            }
        },
    )


@app.get("/v1/health")
async def health():
    if not loaded:
        return {
            "status": "loading",
            "model": model_name_arg,
            "dimensions": None,
            "device": None,
            "uptime_seconds": int(time.time() - start_time),
        }
    return {
        "status": "ok",
        "model": model_name_arg,
        "dimensions": dims,
        "device": device_name,
        "uptime_seconds": int(time.time() - start_time),
    }


def _load(mname: str, dev: str | None):
    global model, model_name_arg, device_name, dims, loaded
    logger.info(f"Loading model {mname} (device={dev or 'auto'})...")
    if dev is None:
        dev = "cuda" if torch.cuda.is_available() else "cpu"
    model = SentenceTransformer(mname, device=dev)
    model_name_arg = mname
    device_name = dev
    dims = model.get_sentence_embedding_dimension()
    loaded = True
    logger.info(f"Loaded: {model_name_arg} ({dims} dims) on {device_name}")


def _count_tokens(texts: List[str]) -> int:
    if model is None or not hasattr(model, "tokenizer"):
        return sum(len(t.split()) for t in texts)
    try:
        return sum(len(model.tokenizer.encode(t)) for t in texts)
    except Exception:
        return sum(len(t.split()) for t in texts)


@app.post("/v1/embeddings")
async def embeddings(req: EmbeddingRequest):
    global loaded
    if not loaded:
        _load(model_name_arg, device_name)

    texts = req.input if isinstance(req.input, list) else [req.input]
    if not texts:
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "message": "input must be a non-empty string or list",
                    "type": "invalid_request",
                    "code": 500,
                }
            },
        )

    try:
        embeddings = model.encode(texts).tolist()
    except Exception as e:
        logger.error(f"Encoding failed: {e}")
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "message": str(e),
                    "type": type(e).__name__,
                    "code": 500,
                }
            },
        )

    data = [
        {"object": "embedding", "index": i, "embedding": emb}
        for i, emb in enumerate(embeddings)
    ]
    token_count = _count_tokens(texts)

    return {
        "object": "list",
        "data": data,
        "model": model_name_arg,
        "usage": {"prompt_tokens": token_count, "total_tokens": token_count},
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("PI_SEARCH_EMBEDDING_PORT", "8765")))
    parser.add_argument("--model", type=str, default=os.environ.get("PI_SEARCH_EMBEDDING_MODEL", "all-MiniLM-L6-v2"))
    parser.add_argument("--device", type=str, default=os.environ.get("SIDECAR_DEVICE"))
    args = parser.parse_args()

    global model_name_arg
    model_name_arg = args.model

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    print(f"SIDECAR_PORT={args.port}", flush=True)

    def handle_sigterm(signum, frame):
        logger.info("Received SIGTERM, shutting down")
        sys.exit(0)

    signal.signal(signal.SIGTERM, handle_sigterm)

    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
