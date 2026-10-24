"""App settings, loaded per environment.

APP_ENV picks the env file: `.env.development` (default) or `.env.production`.
A matching `.env.<APP_ENV>.local` file, if present, overrides it and is not
committed. Real environment variables override both.
"""

import os
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent
APP_ENV = os.getenv("APP_ENV", "development")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(BASE_DIR / f".env.{APP_ENV}", BASE_DIR / f".env.{APP_ENV}.local"),
        extra="ignore",
    )

    app_env: str = APP_ENV
    # Relative paths are resolved from the server directory.
    database_path: Path = Path("data/app.db")
    # Browser origins allowed to call the API and open the WebSocket.
    # Empty = allow any origin.
    cors_origins: list[str] = []
    history_page_size: int = 30
    max_message_length: int = 1000

    # The room's agent. Unset key = the SDK's own lookup (ANTHROPIC_API_KEY
    # in the real environment, or an `ant auth login` profile).
    anthropic_api_key: str | None = None
    agent_name: str = "one"
    agent_model: str = "claude-sonnet-5-5"
    # How many of the latest room messages the agent reads before replying.
    agent_context_messages: int = 50

    @property
    def database_file(self) -> Path:
        path = self.database_path
        return path if path.is_absolute() else BASE_DIR / path


settings = Settings()
