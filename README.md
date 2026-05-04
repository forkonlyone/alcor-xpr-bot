# Alcor XPR Arbitrage Bot

Bot trading otomatis untuk [Alcor Exchange](https://alcor.exchange/v/xpr) di blockchain Proton (XPR). Bot ini mencari peluang arbitrase dan mengeksekusi trade hanya ketika profit sudah dipastikan melalui perhitungan terlebih dahulu.

## Cara Kerja

1. **Scan Pool** — Mengambil data semua pool dari Alcor API secara real-time
2. **Hitung Profit** — Mensimulasikan swap sebelum eksekusi, memastikan output > input
3. **Eksekusi** — Hanya melakukan swap jika profit melebihi threshold minimum
4. **Proteksi** — Slippage protection mencegah kerugian dari perubahan harga mendadak

### Strategi

| Strategi | Deskripsi | Contoh |
|----------|-----------|--------|
| **Direct Round-Trip** | Beli token lalu jual kembali ke XPR | XPR → LOAN → XPR |
| **Cross Fee-Tier** | Beli di pool fee rendah, jual di pool fee berbeda | XPR → XUSDC (0.3%) → XPR (1%) |
| **Triangular** | Swap melalui token perantara | XPR → LOAN → METAL → XPR |

### Keamanan

- **Perhitungan dulu, beli kemudian** — Setiap route dihitung profitnya sebelum eksekusi
- **Slippage protection** — Minimum output dijamin melalui parameter swap
- **Dry run mode** — Test tanpa resiko dengan mode simulasi
- **Failover RPC** — Otomatis beralih ke endpoint lain jika gagal

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/forkonlyone/alcor-xpr-bot.git
cd alcor-xpr-bot
npm install
```

### 2. Konfigurasi

```bash
cp .env.example .env
```

Edit `.env` dan isi:
```
PROTON_USERNAME=namaakun
PROTON_PRIVATE_KEY=PVT_K1_xxxxx
```

### 3. Scan (tanpa trading)

```bash
npm run scan
```

### 4. Jalankan Bot (dry run)

```bash
npm run dry-run
```

### 5. Jalankan Bot (live trading)

```bash
# Ubah DRY_RUN=false di .env, lalu:
npm start
```

## Konfigurasi

| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `PROTON_USERNAME` | *wajib* | Nama akun Proton |
| `PROTON_PRIVATE_KEY` | *wajib* | Private key (active permission) |
| `TRADE_AMOUNT_XPR` | `100` | Jumlah XPR per trade |
| `MIN_PROFIT_PERCENT` | `0.5` | Minimum profit % untuk eksekusi |
| `MAX_SLIPPAGE_PERCENT` | `1.0` | Toleransi slippage maksimum |
| `MIN_POOL_TVL_USD` | `100` | Minimum TVL pool (USD) |
| `SCAN_INTERVAL_MS` | `5000` | Interval scan (ms) |
| `DRY_RUN` | `true` | Mode simulasi |
| `MAX_ROUTE_HOPS` | `3` | Maksimum hop (2=direct, 3=triangular) |
| `LOG_LEVEL` | `info` | Level log (error/warn/info/debug) |

## Arsitektur

```
src/
├── index.js              # Main loop - scan & execute
├── scanner.js            # Standalone scanner (read-only)
├── config/
│   ├── constants.js      # Chain & contract constants
│   └── env.js            # Environment config loader
├── services/
│   ├── alcorApi.js       # Alcor API client & pool management
│   ├── routeFinder.js    # Profit calculation & route discovery
│   └── executor.js       # On-chain swap execution
└── utils/
    ├── logger.js         # Winston logger setup
    └── math.js           # AMM math (price, swap estimation)
```

## Teknologi

- **Runtime**: Node.js (ESM)
- **Blockchain**: Proton (EOSIO) via `@proton/js`
- **DEX**: Alcor Exchange V3 (Concentrated Liquidity AMM)
- **Swap Contract**: `swap.alcor` — transfer dengan memo khusus
- **API**: Alcor REST API untuk data pool real-time

## Peringatan

> **PENTING**: Trading otomatis memiliki resiko. Pastikan Anda memahami resikonya sebelum menggunakan mode live trading. Selalu mulai dengan dry run terlebih dahulu. Gunakan dana yang Anda siap kehilangan.

## Lisensi

MIT
