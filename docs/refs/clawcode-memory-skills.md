# Analisis Teknikal: Memory & Skills System — refs-clawcode

> Referensi: `/workspace/refs-clawcode`  
> Codebase: Python port (`src/`) + Rust port (`rust/`)  
> Fokus: Implementasi Memory dan Skills

---

## Ringkasan

`refs-clawcode` adalah codebase dua lapisan:
- **`src/` (Python)**: Archive/mirror metadata dari TypeScript original. Banyak berupa placeholder + reference data (JSON snapshot dari TypeScript modules).
- **`rust/`**: Implementasi aktif dan bekerja. Full runtime dalam Rust.

Memory dan Skills diimplementasikan penuh di Rust, sedangkan Python `src/` hanya menyimpan metadata arsip untuk reference.

---

## 1. MEMORY SYSTEM

### 1.1 Lokasi File

**Python (Archive):**
```
src/memdir/__init__.py                    # Placeholder kosong
src/reference_data/subsystems/memdir.json # Metadata 8 modul TypeScript asli:
  - memdir/findRelevantMemories.ts
  - memdir/memdir.ts
  - memdir/memoryAge.ts
  - memdir/memoryScan.ts
  - memdir/memoryTypes.ts
  - memdir/paths.ts
  - memdir/teamMemPaths.ts
  - memdir/teamMemPrompts.ts
```

**Rust (Implementasi Aktif):**
```
rust/crates/runtime/src/prompt.rs         # ProjectContext & SystemPromptBuilder
rust/crates/rusty-claude-cli/src/main.rs  # Memory rendering functions
rust/crates/commands/src/lib.rs           # /memory slash command spec
```

---

### 1.2 Format Penyimpanan Memory

Memory disimpan sebagai **instruction files** — file Markdown biasa yang di-discover via ancestor chain walk dari CWD.

**File yang di-scan (prioritas dari CWD ke root):**
```
<project>/
├── CLAUDE.md
├── CLAUDE.local.md
├── .claw/
│   ├── CLAUDE.md
│   └── instructions.md
├── .claude/
│   ├── CLAUDE.md
│   └── instructions.md
├── .codex/          (legacy)
└── .omc/            (legacy)
```

Setiap direktori ancestor diulangi hingga filesystem root — mendukung monorepo hirarki.

---

### 1.3 Memory Flow

```
Startup / Prompt Dikirim ke Model
         |
         v
ProjectContext::discover(&cwd, current_date)
         |
         v
Walk ancestor directories (CWD → filesystem root)
         |
         v
Untuk setiap dir: scan 4 pola file
  - CLAUDE.md
  - CLAUDE.local.md
  - .claw/CLAUDE.md
  - .claw/instructions.md
         |
         v
Kumpulkan ContextFile { path, content }
         |
         v
dedupe_instruction_files()
  (dedup berdasarkan path)
         |
         v
Simpan dalam ProjectContext::instruction_files
         |
         v
SystemPromptBuilder::with_project_context()
         |
         v
render_instruction_files() → String
         |
         v
Injected ke system prompt sebagai section "# Instruction Files"
         |
         v
Dikirim ke model dalam API request
```

**Kapan dibaca:** Setiap kali prompt dikirim ke model; saat `/memory` dijalankan.

**Kapan ditulis:** Tidak ada automatic write. Hanya manual (user edit file) atau via `/init` yang membuat starter `CLAUDE.md`.

---

### 1.4 Mekanisme Discovery (Kode Rust)

```rust
// rust/crates/runtime/src/prompt.rs
fn discover_instruction_files(cwd: &Path) -> std::io::Result<Vec<ContextFile>> {
    let mut directories = Vec::new();
    let mut cursor = Some(cwd);
    while let Some(dir) = cursor {
        directories.push(dir.to_path_buf());
        cursor = dir.parent();
    }
    directories.reverse(); // Root dulu, baru project

    let mut files = Vec::new();
    for dir in directories {
        for candidate in [
            dir.join("CLAUDE.md"),
            dir.join("CLAUDE.local.md"),
            dir.join(".claw").join("CLAUDE.md"),
            dir.join(".claw").join("instructions.md"),
        ] {
            push_context_file(&mut files, candidate)?;
        }
    }
    Ok(dedupe_instruction_files(files))
}

fn dedupe_instruction_files(files: Vec<ContextFile>) -> Vec<ContextFile> {
    let mut seen = std::collections::HashSet::new();
    files.into_iter().filter(|file| {
        seen.insert(file.path.clone())
    }).collect()
}
```

---

### 1.5 Memory Injection ke System Prompt

```rust
// rust/crates/runtime/src/prompt.rs
pub fn build(&self) -> Vec<String> {
    let mut sections = Vec::new();

    // ... sections lain ...

    if let Some(project_context) = &self.project_context {
        sections.push(render_project_context(project_context));
        if !project_context.instruction_files.is_empty() {
            sections.push(render_instruction_files(&project_context.instruction_files));
        }
    }

    sections
}

fn render_instruction_files(files: &[ContextFile]) -> String {
    let mut lines = vec!["# Instruction Files".to_string()];
    for (index, file) in files.iter().enumerate() {
        lines.push(format!("## {}: {}", index + 1, file.path.display()));
        lines.push(truncate_instruction_content(&file.content));
    }
    lines.join("\n\n")
}
```

**Posisi dalam System Prompt:**
```
System Prompt:
├── Intro Section
├── Output Style (jika dikonfigurasi)
├── Base System Section
├── Task Doing Section
├── Actions Section
├── === SYSTEM_PROMPT_DYNAMIC_BOUNDARY ===
├── Environment Context (cwd, date, platform)
├── Project Context (git status, branch)
├── [MEMORY] Instruction Files ← DI SINI
├── Config Section (jika loaded)
└── Appended Sections (hooks, dll)
```

---

### 1.6 Tipe Memory

| Level | File | Keterangan |
|-------|------|-----------|
| Project primary | `CLAUDE.md` | Instruksi utama project |
| Project local | `CLAUDE.local.md` | Override lokal, tidak di-commit |
| Namespace `.claw` | `.claw/CLAUDE.md` | Namespace alternatif |
| Namespace `.claw` | `.claw/instructions.md` | Instruksi sekunder |
| Ancestor chain | Parent dir files | Untuk monorepo hierarki |
| Legacy | `.codex/`, `.omc/` | Backward compatibility |

Tidak ada tipe semantik (user/feedback/project) — semua di-treat sama sebagai **instruction files**.

---

### 1.7 Konfigurasi Memory

```rust
// Dari config spec
"autoMemoryEnabled" => ConfigSettingSpec {
    scope: ConfigScope::Settings,
    kind: ConfigKind::Boolean,
    path: &["autoMemoryEnabled"],
}
```

Config via `.claw.json` (project) atau `~/.claude/settings.json` (user).

**Slash Command `/memory`:**
```rust
SlashCommandSpec {
    name: "memory",
    aliases: &[],
    summary: "Inspect loaded Claude instruction memory files",
    argument_hint: None,
    resume_supported: true,
}
```

---

## 2. SKILLS SYSTEM

### 2.1 Lokasi File

**Python (Archive):**
```
src/skills/__init__.py                      # Placeholder kosong
src/reference_data/subsystems/skills.json   # Metadata 20 modul TypeScript:
  - skills/bundled/batch.ts
  - skills/bundled/claudeApi.ts
  - skills/bundled/claudeApiContent.ts
  - skills/bundled/claudeInChrome.ts
  - skills/bundled/debug.ts
  - skills/bundled/keybindings.ts
  - skills/bundled/loop.ts
  - skills/bundled/remember.ts
  - skills/bundled/scheduleRemoteAgents.ts
  - skills/bundled/simplify.ts
  - skills/bundled/skillify.ts
  - skills/bundled/stuck.ts
  - skills/bundled/updateConfig.ts
  - skills/bundled/verify.ts
  - skills/bundled/verifyContent.ts
  - skills/bundledSkills.ts
  - skills/loadSkillsDir.ts
  - skills/mcpSkillBuilders.ts
```

**Rust (Implementasi Aktif):**
```
rust/crates/tools/src/lib.rs        # Skill resolution + execution
rust/crates/commands/src/lib.rs     # /skills slash command spec
rust/crates/plugins/src/lib.rs      # Plugin/skill lifecycle
```

---

### 2.2 Format Definisi Skill

Setiap skill adalah folder dengan file `SKILL.md`:

```
<skill-dir>/
└── SKILL.md     # Definisi skill (required)
    (file lain TIDAK auto-loaded, perlu direferensikan manual)
```

**Format `SKILL.md` dengan frontmatter:**
```markdown
---
name: "Skill Name"
description: "Deskripsi opsional"
---

# Isi Skill

Instruksi dan implementasi skill dalam Markdown.
```

**Parsing frontmatter (Rust):**
```rust
fn parse_skill_name(contents: &str) -> Option<String> {
    parse_skill_frontmatter_value(contents, "name")
}

fn parse_skill_frontmatter_value(contents: &str, key: &str) -> Option<String> {
    let mut lines = contents.lines();
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }

    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" { break; }
        if let Some(value) = trimmed.strip_prefix(&format!("{key}:")) {
            let value = value
                .trim()
                .trim_matches(|ch| matches!(ch, '"' | '\''))
                .trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}
```

---

### 2.3 Skill Loading: Lazy On-Demand

Skills **TIDAK pre-loaded** saat startup. Loading terjadi on-demand:

1. **Eager (metadata)**: `/skills list` scan semua direktori untuk nama + deskripsi
2. **Lazy (content)**: `/skills <name>` atau `Skill` tool baru membaca isi `SKILL.md`

Tidak ada persistent cache — setiap lookup membaca ulang dari disk.

---

### 2.4 On-Demand Skill Loading: Mekanisme

**Skill Resolution Algorithm:**

```rust
// rust/crates/tools/src/lib.rs
fn resolve_skill_path(skill: &str) -> Result<std::path::PathBuf, String> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;

    // 1. Coba project-level (ancestor walk)
    match commands::resolve_skill_path(&cwd, skill) {
        Ok(path) => Ok(path),
        // 2. Fallback ke compat roots (env vars, home dir)
        Err(_) => resolve_skill_path_from_compat_roots(skill),
    }
}

fn resolve_skill_path_from_compat_roots(skill: &str) -> Result<std::path::PathBuf, String> {
    let requested = skill.trim()
        .trim_start_matches('/')
        .trim_start_matches('$');

    for root in skill_lookup_roots() {
        if let Some(path) = resolve_skill_path_in_root(&root, requested) {
            return Ok(path);
        }
    }

    Err(format!("unknown skill: {requested}"))
}
```

**Skill Lookup Roots (Urutan Prioritas):**

```
1. Project-level (ancestor chain dari CWD):
   - .omc/skills/
   - .agents/skills/
   - .claw/skills/
   - .codex/skills/
   - .claude/skills/

2. Environment variables:
   - $CLAW_CONFIG_HOME/skills/
   - $CODEX_HOME/skills/
   - $HOME/.omc/skills/
   - $HOME/.claw/skills/
   - $HOME/.codex/skills/
   - $HOME/.claude/skills/
   - $HOME/.agents/skills/
   - $HOME/.config/opencode/skills/

3. Config directory ($CLAUDE_CONFIG_DIR):
   - $CLAUDE_CONFIG_DIR/skills/
   - $CLAUDE_CONFIG_DIR/skills/omc-learned/
   - $CLAUDE_CONFIG_DIR/commands/  (legacy)
```

---

### 2.5 Skill Invocation Flow

**Via Slash Command `/skills <name>`:**
```
User: /skills github
         |
         v
commands::SlashCommand::parse("/skills github")
         |
         v
SlashCommand::Skills { args: Some("github") }
         |
         v
execute_skill(SkillInput { skill: "github", args: None })
         |
         v
resolve_skill_path("github")
  → scan lookup roots
  → found: ~/.claw/skills/github/SKILL.md
         |
         v
fs::read_to_string(&skill_path)
         |
         v
parse_skill_description() untuk extract metadata
         |
         v
Return SkillOutput { skill, path, args, description, prompt }
```

**Via Tool (`Skill` tool dipanggil model):**
```
Model invokes Skill tool:
  { "skill": "github", "args": "list PRs" }
         |
         v
tools::execute_tool("Skill", input)
         |
         v
run_skill(SkillInput::from_value(input))
         |
         v
execute_skill() — logic sama dengan slash command
         |
         v
Return SkillOutput sebagai JSON ke model
```

**Tool Definition:**
```rust
ToolSpec {
    name: "Skill",
    description: "Load a local skill definition and its instructions.",
    input_schema: {
        "skill": { "type": "string" },    // required
        "args": { "type": "string" },     // optional
    },
    required: ["skill"],
}
```

---

### 2.6 Skill Discovery dalam Direktori

Skill dalam subdirektori di-resolve dengan dua pola:

1. **File langsung**: `skills/github.md` (legacy)
2. **Subdirectory**: `skills/github/SKILL.md` (rekomendasi)

```rust
fn resolve_skill_path_in_root(root: &Path, skill: &str) -> Option<std::path::PathBuf> {
    // Coba direct .md file
    let direct = root.join(format!("{skill}.md"));
    if direct.exists() { return Some(direct); }

    // Coba subdirectory dengan SKILL.md
    let subdir = root.join(skill).join("SKILL.md");
    if subdir.exists() { return Some(subdir); }

    None
}
```

---

### 2.7 Tipe Skill

| Tipe | Lokasi | Keterangan |
|------|--------|-----------|
| **Bundled** | Arsip TypeScript (14 skills) | batch, loop, remember, simplify, dll |
| **User-defined** | `.claw/skills/` atau `~/.claw/skills/` | Custom user skills |
| **Community/Learned** | `omc-learned/` subdir | Dipelajari/didownload dari komunitas |
| **Legacy commands** | `commands/` dir | Backward compat, `.md` langsung |

**Bundled Skills (dari arsip):**
- `batch` — batch operations
- `claudeApi` — Claude API integration
- `loop` — iterative loops
- `remember` — memory creation
- `simplify` — code simplification
- `scheduleRemoteAgents` — remote agent scheduling
- `updateConfig` — config updates
- `verify` — verification workflows
- `skillify` — meta-skill creator

---

### 2.8 Multiple Files Per Skill

Saat ini implementasi hanya auto-load `SKILL.md`. File tambahan dalam direktori skill **tidak otomatis** di-load:

```
~/.claw/skills/my-skill/
├── SKILL.md          ← HANYA INI yang di-load otomatis
├── helper.py         ← Tidak auto-loaded
├── data.json         ← Tidak auto-loaded
└── README.md         ← Tidak auto-loaded
```

Jika skill perlu referensikan file lain, harus ditulis secara eksplisit di isi `SKILL.md` (misalnya, `run python helper.py`).

**Slash Command `/skills`:**
```rust
SlashCommandSpec {
    name: "skills",
    aliases: &["skill"],
    summary: "List, install, or invoke available skills",
    argument_hint: Some("[list|install <path>|help|<skill> [args]]"),
    resume_supported: true,
}
```

---

## 3. PERBANDINGAN PYTHON vs RUST

| Aspek | Python (`src/`) | Rust (`rust/`) |
|-------|-----------------|----------------|
| **Status** | Archive metadata / placeholder | Full working runtime |
| **Memory discovery** | Tidak ada implementasi | `discover_instruction_files()` |
| **Memory injection** | Tidak ada | `SystemPromptBuilder` → system prompt |
| **Memory types** | Terdokumentasi di JSON | CLAUDE.md, CLAUDE.local.md, .claw/* |
| **Skill resolution** | Tidak ada | Multi-root lazy lookup |
| **Skill frontmatter** | Tidak ada parser | Custom YAML-style parser |
| **Skill tool** | Arsip name saja | Full `Skill` tool + CLI command |
| **Skill search** | Tidak ada | 7+ env-aware lookup paths |
| **Skills archive** | 20 modul terdokumentasi | Runtime loading dari filesystem |

---

## 4. ARSITEKTUR KESELURUHAN

### Memory Architecture
```
File System (CLAUDE.md, .claw/CLAUDE.md, dll)
        ↓ [discover on startup & per prompt]
ProjectContext::instruction_files[]
        ↓ [inject via SystemPromptBuilder]
System Prompt → Model → Response
```

### Skills Architecture
```
File System (SKILL.md di banyak roots)
        ↓ [lazy lookup saat invoke]
resolve_skill_path() → path
        ↓ [read file on demand]
SkillOutput { content, metadata }
        ↓ [returned ke model atau user]
Model menggunakan skill content sebagai instruksi
```

### Perbedaan Utama Memory vs Skills
- **Memory**: Auto-injected setiap prompt, persistent project context
- **Skills**: On-demand, hanya load saat dipanggil eksplisit
- **Memory**: Tidak perlu invokasi — selalu ada
- **Skills**: Perlu trigger eksplisit via `/skills <name>` atau `Skill` tool
