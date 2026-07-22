# vHeap

vHeap 是一个面向 GDB/pwndbg 的 glibc ptmalloc 堆可视化工具。它从正在调试的进程中读取堆状态，将 bin、chunk、allocator 管理结构和任意地址的内存内容展示在浏览器中，适合 CTF heap 题分析、调试和教学。

当前版本由两部分组成：

- `vheap.py`：运行在 GDB/pwndbg 中的 Python 后端，负责采集堆信息和读取目标内存。
- `frontend/`：Vite + React + TypeScript 前端，负责图布局、结构体解析和内存视图。

## 功能

- 显示 tcache、fastbin、unsortedbin、smallbin、largebin 和 allocated chunk。
- 显示 `malloc_state`、`heap_info`、tcache 等 ptmalloc 管理结构（取决于目标和调试符号）。
- 用指针边连接 chunk、管理结构和其他内存视图。
- 在 Inspector 中按 `malloc_chunk`、`_IO_FILE`、`_IO_FILE_plus`、`_IO_jump_t`、`_IO_wide_data` 重新解释数据。
- 输入任意地址并选择结构体类型，在主图中创建 typed memory 节点。
- 在底部 memory region dock 中按 16 字节一行查看绝对地址、单字节十六进制值和 ASCII；不可读取的字节显示为 `--`。
- 所有读取操作均为只读，不会修改被调试进程。

## 环境要求

推荐在 Linux 环境使用：

- GDB 11 或更高版本。
- 已安装并能正常工作的 [pwndbg](https://github.com/pwndbg/pwndbg)。
- Python 3，以及 pwndbg 自带的 `.venv` 虚拟环境。
- Node.js 20.19 或更高版本。
- pnpm 10（用于构建 TypeScript 前端）。
- 使用 glibc/ptmalloc 的正在运行的用户态程序。

后端依赖位于 `requirements.txt`，包括 `python-socketio`、`aiohttp` 和 `requests`。

## 安装

### 1. 获取代码

```bash
git clone https://github.com/XxingGoD/vheap.git
cd vheap
```

### 2. 准备 pwndbg

先按照 pwndbg 官方文档完成安装，并确认以下文件存在：

```text
PWNDBG_PATH/.venv/bin/python3
```

例如 pwndbg 位于 `/opt/pwndbg`，执行：

```bash
./setup.sh /opt/pwndbg
```

`setup.sh` 会完成以下操作：

1. 使用 pwndbg 虚拟环境安装 Python 依赖。
2. 执行 `pnpm install --frozen-lockfile` 和 `pnpm build`（系统存在 pnpm 时）。
3. 将当前仓库的 `vheap.py` 加入 `~/.gdbinit`。

重新打开 GDB 后，使用下面的命令确认 vHeap 已加载：

```gdb
(gdb) help vhserv
(gdb) help vhstate
(gdb) help vhstop
```

### 3. 手动安装或重新构建

如果没有使用 `setup.sh`，可以分别执行：

```bash
/opt/pwndbg/.venv/bin/python3 -m pip install -r requirements.txt
pnpm install --frozen-lockfile
pnpm build
```

构建结果位于 `vheapViews/dist/`，`vhserv` 会优先提供该目录中的前端资源。

## 使用 vHeap

### 1. 启动 GDB 和目标程序

```bash
gdb ./challenge
```

在 GDB 中运行程序，直到堆已经初始化。例如：

```gdb
(gdb) start
```

对于需要输入的题目，也可以使用 `run`、断点或 pwndbg 的其他命令停在合适的位置。

### 2. 启动 Web 服务

在 GDB 中执行：

```gdb
(gdb) vhserv localhost 8080 --data-bytes 128
```

然后在浏览器打开：

```text
http://127.0.0.1:8080
```

参数说明：

| 参数 | 说明 |
| --- | --- |
| `host` | Web 服务监听地址，默认 `localhost`。 |
| `port` | Web 服务端口，默认 `8080`。 |
| `--data-bytes N` | 每个 chunk 最多读取的 payload 字节数，默认 `64`，范围为 `0` 到 `65536`。 |
| `--no-auto-update` | 不在每次 GDB stop 时自动刷新堆状态。 |
| `--no-structures` | 不采集 ptmalloc 管理结构。 |

例如：

```gdb
# 读取更多 chunk payload，便于查看 _IO_FILE
(gdb) vhserv localhost 1337 --data-bytes 256

# 关闭自动更新并隐藏管理结构
(gdb) vhserv localhost 8080 --no-auto-update --no-structures
```

停止服务：

```gdb
(gdb) vhstop
```

### 3. 刷新堆状态

服务启动时会自动采集一次状态。程序发生 malloc/free 或 GDB 停止后，可以手动执行：

```gdb
(gdb) vhstate
```

也可以在刷新时调整 payload 和管理结构设置：

```gdb
(gdb) vhstate --data-bytes 256
(gdb) vhstate --data-bytes 0
(gdb) vhstate --structures
(gdb) vhstate --no-structures
```

`--data-bytes 0` 只会关闭普通 chunk payload 的采集；前端的任意地址 memory view 仍可以单独发起内存读取。

## 前端界面

### 堆图

- 左侧栏可以按 bin、地址、字段和关键字筛选节点。
- `flow` 和 `stack` 两种布局分别对应横向和纵向排列。
- chunk、management structure、memory view 和 bin head 使用不同颜色区分。
- 点击节点可以在右侧 Inspector 查看字段、指针和原始 JSON。
- 指针字段会自动尝试连接到匹配地址的 chunk 或结构体。

### Chunk 结构体解析

选中一个 chunk 后，在 Inspector 的 `reinterpret payload` 中选择类型：

| 类型 | 用途 |
| --- | --- |
| `malloc_chunk` | 查看 ptmalloc chunk 头、size、fd/bk 和 large-bin 链。 |
| `_IO_FILE` | 按 glibc FILE 布局解析字段和 `_IO` flags。 |
| `_IO_FILE_plus` | 在 `_IO_FILE` 后继续解析 vtable 指针。 |
| `_IO_jump_t` | 查看 FILE 虚函数表指针。 |
| `_IO_wide_data` | 查看 wide stream 的常用前缀字段。 |

结构体布局依赖目标架构和 libc 版本。64 位常见 glibc 中 `_IO_FILE_plus` 的 vtable 通常位于 `0xd8`，但制作 payload 前必须用目标环境的 `ptype`、`pahole` 或 libc 源码确认。

如果字段被标记为 unavailable，增加采集长度：

```gdb
(gdb) vhstate --data-bytes 256
```

### 任意地址 memory view

1. 在左侧 `memory views` 区域输入十六进制或十进制地址。
2. 选择结构体类型。
3. 可选地填写读取字节数；留空时使用该结构体的预期大小。
4. 点击 `parse address`。

前端会在主图创建一个 memory 节点，并根据解析出的指针字段连接到已有节点。同一个地址和类型再次提交时会更新原节点，不会创建重复节点。

选中 memory 节点后，画布底部会打开 memory region dock：

- 每行固定 16 个字节，左侧显示绝对起始地址。
- 表头为 `00` 到 `0f`，每个单元格显示两位十六进制值。
- 右侧显示可打印 ASCII，控制字符显示为 `.`。
- 目标内存不可读或返回不完整时，对应单元格显示 `--`。
- dock 支持切换已有 memory view、刷新、折叠和关闭。

单次任意地址读取最多 `0x10000` 字节，且只读目标内存。

## 不启动 GDB 的 Demo

TypeScript 前端自带 demo snapshot，可以先验证界面和内存视图：

```bash
pnpm install --frozen-lockfile
pnpm dev
```

打开：

```text
http://127.0.0.1:5173/?demo=1
```

在左侧输入以下示例：

```text
address: 0x2000
type:    _IO_FILE_plus
bytes:   224
```

点击 `parse address` 后，可以同时查看 typed memory 节点、Inspector 字段和底部原始内存区域。Demo 不连接 GDB，也不会读取或修改本机内存。

## 前端开发命令

在仓库根目录执行：

```bash
# 安装依赖
pnpm install --frozen-lockfile

# 启动 Vite 开发服务器，默认端口 5173
pnpm dev

# 严格 TypeScript 检查
pnpm typecheck

# 生成生产构建到 vheapViews/dist
pnpm build

# 预览生产构建
pnpm preview
```

开发服务器会将 `/socket.io` 代理到 `127.0.0.1:8080`。因此要在开发模式测试真实 GDB 数据，先在 GDB 中运行：

```gdb
(gdb) vhserv localhost 8080
```

## 常见问题

### 浏览器显示 Waiting for heap data 或 Heap snapshot is empty

确认目标程序已经运行到堆初始化之后，并在 GDB 中执行：

```gdb
(gdb) vhstate
```

同时检查浏览器地址中的端口是否与 `vhserv` 使用的端口一致。

### Inspector 中 payload unavailable

普通 chunk payload 受 `--data-bytes` 限制。增大限制后重新采集：

```gdb
(gdb) vhstate --data-bytes 256
```

如果使用了 `--data-bytes 0`，普通 chunk payload 会被明确标记为 disabled。

### GDB 中找不到 `vhserv`

确认 `setup.sh` 使用的是正确的 pwndbg 根目录，并重新启动 GDB。也可以临时手动加载：

```gdb
(gdb) source /absolute/path/to/vheap/vheap.py
```

### 端口已被占用

换一个端口启动服务，并使用新端口访问：

```gdb
(gdb) vhserv localhost 18080
```

```text
http://127.0.0.1:18080
```

### IO 字段和目标 libc 不一致

IO 结构体是 ABI 相关的。使用目标 libc 的调试信息确认字段偏移，不要直接把其他发行版或其他版本 libc 的偏移用于利用。

## 项目结构

```text
vheap/
├── vheap.py                 # GDB/pwndbg 后端和 Socket.IO 服务
├── setup.sh                 # 安装 Python 依赖、构建前端并接入 gdbinit
├── requirements.txt         # Python 依赖
├── frontend/
│   └── src/
│       ├── App.tsx          # 应用状态和主布局
│       ├── graph.ts         # React Flow 图模型和 ELK 布局
│       ├── data.ts          # 快照、地址和内存字节处理
│       ├── structViews.ts   # malloc_chunk/IO 结构体布局
│       ├── Inspector.tsx    # 节点字段检查器
│       └── MemoryRegionView.tsx # 16 字节内存区域视图
├── testHeaps/               # 示例 heap 测试程序
└── EXTENDING.md             # 数据协议和扩展说明
```

## 限制与安全说明

- 后端依赖 pwndbg 的 ptmalloc 解析器和目标进程状态。
- 管理结构采集是 best-effort；缺少符号或不兼容的 pwndbg 版本时，部分结构可能不会出现。
- 内存读取有大小上限，避免一次请求阻塞 GDB。
- vHeap 只读取目标内存，不提供写内存、修改 chunk 或执行利用的功能。
- 请只在自己拥有或获准调试的程序上使用。

## 扩展开发

数据模型、Socket.IO 事件和新增结构体类型的说明见 [EXTENDING.md](EXTENDING.md)。

## 许可证

本项目使用 BSD 2-Clause License，详见 [LICENSE](LICENSE)。
