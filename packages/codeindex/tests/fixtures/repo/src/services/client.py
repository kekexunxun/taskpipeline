"""Python 夹具：覆盖类 / 函数 / 模块常量 / dataclass / from-import。"""

from dataclasses import dataclass
from typing import List

MAX_RETRIES = 3
DEFAULT_HOST = "localhost"


@dataclass
class Record:
    id: str
    name: str


class ApiClient:
    """一个客户端类。"""

    def __init__(self, host: str = DEFAULT_HOST):
        self.host = host

    def fetch(self, path: str) -> List[Record]:
        return []

    def _internal(self) -> None:
        pass


async def collect(client: ApiClient) -> int:
    return len(client.fetch("/x"))
