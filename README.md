# Nebu

Link-in-bio platformu: kısa kullanıcı adı, UID, rozetler, animasyonlu arka planlar, müzik, canlı önizlemeli dashboard ve gerçek analitik.

## Çalıştırma

Gereksinim: **Node.js 22.13 veya üzeri**. Dış paket yok, `npm install` gerekmez.

```bash
node server.js
# http://localhost:3000
```

Ortam değişkenleri:

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | `3000` | Dinlenecek port |
| `DATA_DIR` | `./data` | SQLite veritabanının klasörü (`nebu.db`) |
| `NODE_ENV` | | `production` ise çerez `Secure` olur (HTTPS şart) |
| `TRUST_PROXY` | | Nginx/Cloudflare arkasındaysan `1` yap (gerçek IP için) |

## Özellikler

- Kayıt / giriş (scrypt ile şifre hash, httpOnly oturum çerezi), kullanıcı adı müsaitlik kontrolü, 1-30 karakter
- UID (kayıt sırası), ilk 250 hesaba **OG** rozeti, kısa isim ve veteran rozetleri
- Herkese açık sayfa: `/kullaniciadi`
- 7 arka plan (aurora, particles, grid, gradient, stars, waves, solid), 2 renk + vurgu + yazı rengi
- 4 kart görünümü, 7 font, glow, daktilo biyografi, müzik ("click to enter"), konum ve Discord alanı
- Link yönetimi: ekle, düzenle, yukarı/aşağı taşı, sabitle, gizle, sil, tık sayısı
- Analitik: görüntülenme, tekil ziyaretçi, tık, tık oranı, kaynaklar, cihazlar, en çok tıklanan linkler (bot ve kendi ziyaretlerin sayılmaz)
- Canlı önizleme, kaydedilmemiş değişiklik uyarısı, kullanıcı adı değiştirme, hesap silme

## Güvenlik notları

- Linkler yalnızca http(s) ve mailto kabul eder (`javascript:` vb. reddedilir)
- Tüm kullanıcı içeriği `textContent` ile basılır, renk/font/arka plan değerleri sunucuda beyaz listeyle doğrulanır
- Değiştirici API çağrıları JSON zorunlu (basit CSRF koruması), giriş ve kayıt için hız sınırı var
- Üretimde HTTPS kullan ve veritabanı klasörünü yedekle

## Operasyon

- `GET /healthz`: sağlık kontrolü (`{"ok":true,"schema":1}`), Render health check bunu kullanır
- `GET /api/export`: giriş yapmış kullanıcının tüm verisi JSON olarak (dashboard > Overview > "Download my data")
- Veritabanı şeması `PRAGMA user_version` ile sürümlenir. Şemayı değiştirmek için `server.js` içindeki `MIGRATIONS` dizisine yeni bir giriş **ekle**, eskileri düzenleme
- SIGTERM/SIGINT'te sunucu açık istekleri bitirip veritabanını temiz kapatır

### Render'da kalıcı veri

SQLite dosyası diskte durur. Render ücretsiz planında disk **geçici**dir: her deploy ve yeniden başlatmada veriler silinir. Kalıcı olması için:

1. Servisi `starter` veya üstü bir plana al
2. Servise bir disk ekle, mount yolu `/var/data`
3. `DATA_DIR=/var/data` ortam değişkenini ver

Hepsi `render.yaml` dosyasında tanımlı (Blueprint ile yeni servis oluşturursan otomatik gelir).

## Yapı

```
server.js          sunucu, API, SQLite (node:sqlite)
public/index.html  tanıtım sayfası
public/login.html  giriş / kayıt
public/dashboard.html  Overview, Customize, Links, Analytics
public/profile.html    herkese açık profil sayfası
public/bg.js       animasyonlu arka plan motoru
```
