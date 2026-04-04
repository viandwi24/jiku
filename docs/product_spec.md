# Product Spec — Jiku

## What is this product?

Jiku adalah **agentic AI platform** dengan arsitektur multi-tenant. Platform ini memungkinkan perusahaan membangun dan mengelola AI agent yang dapat berinteraksi dengan pengguna melalui dua mode: chat (percakapan interaktif) dan task (eksekusi otonom berbasis goal).

Hierarki entitas utama:
```
Company → Project → Agent → Conversation (Chat / Task mode)
```

## Goals

- Menyediakan runtime agent yang modular dan extensible lewat plugin system
- Memisahkan permission/policy dari code — semua aturan akses adalah data yang bisa diubah runtime
- Mendukung multi-mode: chat untuk interaksi user, task untuk otomasi background
- Zero-dependency core — `@jiku/core` tidak tahu tentang DB atau storage implementasi
- Developer experience yang baik untuk plugin author lewat `@jiku/kit` SDK

## Target Users

- **SaaS builders** yang ingin embed AI agent ke produk mereka dengan kontrol akses per-user
- **Enterprises** yang butuh multi-tenant AI dengan isolation per company/project
- **Plugin authors** yang ingin extend fungsionalitas agent
