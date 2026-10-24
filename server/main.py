from fastapi import FastAPI

app = FastAPI(title="One House API")


@app.get("/")
def read_root() -> dict[str, str]:
    return {"name": "One House", "status": "ok"}
