# 凭证接入指南：把你的密钥管理器接到 `process.env`

这份文档只讲一件事：**怎么让你手头的密钥管理器，把密钥送进 `dsh web` 进程的环境变量。**

## 一、插件这边的契约（只有一条）

插件**只读 `process.env`**，而且在进程启动时读一次。它不认任何密钥管理器的 API、
不调用任何 CLI、不解析任何私有格式的文件。

所以你要做的只有一件事：**让 `dsh web` 启动时，环境变量里已经有那些键。**

```
你的密钥管理器  ──注入环境变量──▶  dsh web 进程  ──读 process.env──▶  插件
```

只要满足这一条，**用什么都行** —— 插件不需要、也不应该知道你的密钥从哪来。

> 这正是"`process.env` 只关心键在不在，不关心值从哪来"的含义。
> 手动 `export`、`.env`、Docker `-e`、CI Secret、1Password / Vault / AWS Secrets Manager……
> 对插件而言完全等价。

### 需要注入哪些键

`OSS_PROVIDER` 决定用哪一组（不设则按 `rustfs`）：

| provider | 必须注入的键 | 可选 |
| --- | --- | --- |
| **`rustfs`**（默认） | `RUSTFS_ENDPOINT`、`RUSTFS_BUCKET`、`RUSTFS_ACCESS_KEY`、`RUSTFS_SECRET_KEY` | `RUSTFS_REGION`（默认 `us-east-1`） |
| **`aliyun`** | `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、`OSS_BUCKET` | `OSS_REGION`（默认 `oss-cn-hangzhou`）、`OSS_ENDPOINT`（留空自动推导） |
| **`aws`** | `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`AWS_BUCKET`、`AWS_REGION` | `AWS_ENDPOINT` |

另外还有两个**非机密**的开关（也可以走环境变量）：`OSS_AUTO_BACKUP`、`OSS_BACKUP_PREFIX`。

**哪些算机密**：`*_ACCESS_KEY*`、`*_SECRET*`、`*_SESSION_TOKEN`。
**哪些不算**：endpoint、bucket、region、provider —— 这些也可以直接写在设置界面的「高级设置」里。

### 优先级

```
.env 文件  >  系统环境变量  >  设置界面里的「高级设置」
```

`.env` 排在系统环境之前是有意的：它是你**显式写下来**的那一份，比机器上残留的旧
`export` 更权威。被覆盖的键名会进日志和界面（**只有名字，没有值**）。

---

## 二、几种常见的接法

下面每一条的核心都是同一件事：**用一个包装命令启动 `dsh web`，让它在子进程环境里注入密钥。**

### 1Password CLI

在 1Password 里存好字段，然后：

```bash
# 方式 A：引用文件（推荐，密钥不进 shell 历史）
cat > .env.tpl <<'EOF'
RUSTFS_ENDPOINT=http://127.0.0.1:9000
RUSTFS_BUCKET=dsh-backup
RUSTFS_ACCESS_KEY=op://Private/rustfs-backup/access-key
RUSTFS_SECRET_KEY=op://Private/rustfs-backup/secret-key
EOF
op run --env-file=.env.tpl -- dsh web

# 方式 B：环境里直接写引用
export RUSTFS_ACCESS_KEY='op://Private/rustfs-backup/access-key'
export RUSTFS_SECRET_KEY='op://Private/rustfs-backup/secret-key'
op run -- dsh web
```

`op run` 会把 `op://` 引用解析成真实值，**只存在于子进程环境里**，不落盘。

### Bitwarden Secrets Manager CLI

```bash
# bws 需要先设好访问令牌（BWS_ACCESS_TOKEN）
bws run -- dsh web
```

若用普通 Bitwarden 密码库，可以取出来再启动（注意：这样值会进 shell 环境，属于次优解）：

```bash
export RUSTFS_ACCESS_KEY="$(bw get password rustfs-ak)"
export RUSTFS_SECRET_KEY="$(bw get password rustfs-sk)"
dsh web
```

### HashiCorp Vault

```bash
# 取出来注入（Vault 没有官方的"包一层执行"命令，用 envconsul 更省事）
export RUSTFS_ACCESS_KEY="$(vault kv get -field=access_key secret/rustfs)"
export RUSTFS_SECRET_KEY="$(vault kv get -field=secret_key secret/rustfs)"
dsh web
```

用 [envconsul](https://github.com/hashicorp/consul-template) 的话：

```bash
envconsul -secret secret/rustfs dsh web
```

### AWS Secrets Manager

```bash
# 假设密钥存成 JSON：{"accessKeyId":"...","secretAccessKey":"..."}
read -r AK SK < <(aws secretsmanager get-secret-value \
  --secret-id dsh/rustfs \
  --query SecretString --output text \
  | python -c 'import json,sys; d=json.load(sys.stdin); print(d["accessKeyId"], d["secretAccessKey"])')

RUSTFS_ACCESS_KEY="$AK" RUSTFS_SECRET_KEY="$SK" \
RUSTFS_ENDPOINT=http://127.0.0.1:9000 RUSTFS_BUCKET=dsh-backup \
dsh web
```

> 上面用的是**行内环境变量赋值**，它只作用于这一条命令，不会留在你的 shell 里。

### Azure Key Vault

```bash
export RUSTFS_ACCESS_KEY="$(az keyvault secret show --vault-name my-vault --name rustfs-ak --query value -o tsv)"
export RUSTFS_SECRET_KEY="$(az keyvault secret show --vault-name my-vault --name rustfs-sk --query value -o tsv)"
dsh web
```

### Doppler

```bash
doppler run -- dsh web
```

### direnv（适合"每个项目一套配置"）

在项目目录建 `.envrc`（**记得把 `.envrc` 加进 `.gitignore`**）：

```bash
# .envrc
export RUSTFS_ENDPOINT=http://127.0.0.1:9000
export RUSTFS_BUCKET=dsh-backup

# 机密不写在文件里，而是从密码管理器取
export RUSTFS_ACCESS_KEY="$(op read 'op://Private/rustfs-backup/access-key')"
export RUSTFS_SECRET_KEY="$(op read 'op://Private/rustfs-backup/secret-key')"
```

然后 `direnv allow`，进入目录时自动注入。

### Docker / Docker Compose

```bash
# 直接把值传进去（值别写死在 compose 文件里）
docker run -e RUSTFS_ENDPOINT -e RUSTFS_BUCKET \
           -e RUSTFS_ACCESS_KEY -e RUSTFS_SECRET_KEY \
           my-dsh-image
```

Compose 里推荐"只写变量名、值从宿主环境取"：

```yaml
services:
  dsh:
    image: my-dsh-image
    environment:
      - RUSTFS_ENDPOINT
      - RUSTFS_BUCKET
      - RUSTFS_ACCESS_KEY     # 值来自宿主环境，不落在 compose 文件里
      - RUSTFS_SECRET_KEY
```

Docker Swarm 的 secret 是**文件**而不是环境变量，需要包一层：

```bash
command: sh -c 'export RUSTFS_ACCESS_KEY="$$(cat /run/secrets/rustfs_ak)"; dsh web'
```

### systemd（Linux 服务）

```ini
# /etc/systemd/system/dsh.service.d/credentials.conf
[Service]
# 机密用只有 root 可读的文件（chmod 600）
EnvironmentFile=/etc/dsh/credentials.env
```

### 最简：`.env`

没有密钥管理器的话，直接用一个 `.env` 文件（**务必确认它在 `.gitignore` 里**）：

```bash
cp .env.example .env
# 编辑 .env，填上值
dsh web
```

插件启动时会自动读这两个位置中**第一个存在的**：

1. `<DSH home>/oss-backup/.env`（`DSH home` 默认是 `~/.dsh`）
2. 当前工作目录的 `.env`

---

## 三、验证接好了没

**① 看启动日志**（只列变量名，不显示值）：

```
[oss-backup] .env（/home/me/.dsh/oss-backup/.env）读入 2 个变量：RUSTFS_ACCESS_KEY、RUSTFS_SECRET_KEY
[oss-backup] 已从系统环境补读 RUSTFS_BUCKET（值不显示）
```

**② 看设置界面的「凭证」块**，会写明当前来源：

- `.env（RUSTFS_ACCESS_KEY、RUSTFS_SECRET_KEY）`
- `系统环境变量（自动补读：…）`
- `本次进程已注入：…`（指你在设置页临时填的，重启后失效）

**③ 看「环境自检」**：密钥两行应显示「已设置（值不显示）」，且状态为「就绪」——
如果显示「变量齐了，但服务连不上」，说明**值注入成功了**，只是服务本身没起或端点不对。

---

## 四、别这么做（反模式）

| 反模式 | 为什么不行 |
| --- | --- |
| **把密钥写进插件的配置文件** | 插件**不读**也不写 `~/.dsh/oss-backup/config.json` 里的凭证字段；写进去只会被丢弃 |
| **指望插件去调 `op` / `vault` 命令** | 插件不启动子进程、不调外部 CLI —— 它只读环境变量 |
| **把密钥写死在 Dockerfile / compose 文件里** | 会进镜像层和版本库；用 `-e VAR`（只写名字）或 secret |
| **在 shell 里 `export` 完就提交了脚本** | 值会进脚本文件；改用密码管理器或 `.env`（并确保被 gitignore） |
| **把填好值的 `.env` 提交进仓库** | `.gitignore` 已挡住 `.env` / `.env.*`，但**别依赖它** —— 先确认 `git status` 里没有它 |
| **用主账号 AK/SK** | 请用最小权限子账号（只给目标桶的 `PutObject`），见 README 第 2 步 |

---

## 五、一句话总结

> 插件只认 `process.env`。**用任意方式在启动 `dsh web` 之前把键注入进去就行** ——
> 而既然要注入，就**优先用你的密钥管理器**：让密钥留在它该待的地方，
> 而不是躺在某个磁盘文件或 shell 历史里。
