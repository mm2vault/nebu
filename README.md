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

### Otomatik GitHub yedeği (diski olmayan hosting için)

Hesaplar, linkler ve istatistikler değişince **şifrelenmiş** bir snapshot özel bir GitHub deposuna yazılır; açılışta veritabanı boşsa son snapshot geri yüklenir. Böylece Render ücretsiz planında bile veriler deploy ve yeniden başlatmalardan sonra geri gelir.

Kurulum:

1. **Özel (private)** boş bir depo aç, ör. `mm2vault/nebu-data`. Public olmamalı.
2. GitHub > Settings > Developer settings > Fine-grained tokens: sadece bu depoya erişen, **Contents: Read and write** izinli bir token üret.
3. Sunucuya ortam değişkenleri:

| Değişken | Açıklama |
|---|---|
| `SNAPSHOT_REPO` | `kullanici/depo`, ör. `mm2vault/nebu-data` |
| `GITHUB_TOKEN` | 2. adımdaki token (sadece Render ortam değişkeni, koda yazma) |
| `SNAPSHOT_KEY` | Uzun rastgele bir parola. Snapshot AES-256-GCM ile bununla şifrelenir. **Kaybedersen yedek okunamaz**, bir yere de kaydet |
| `SNAPSHOT_INTERVAL_MS` | İsteğe bağlı, varsayılan `120000` (en fazla 2 dakikada bir yazar) |

Bilmen gerekenler:
- Kapanırken (deploy/SIGTERM) son bir snapshot yazılır. Ani çökmede en fazla son aralıktaki değişiklikler kaybolur.
- Oturumlar yedeklenmez, geri yüklemeden sonra herkes yeniden giriş yapar.
- Geri yükleme başarısız olursa (yanlış anahtar, GitHub erişilemiyor, depo yok) sunucu **bilerek başlamaz**, boş bir veritabanı iyi yedeğin üstüne yazılmasın diye.
- Yalnızca **tek sunucu örneği** için tasarlandı. Her snapshot repoda bir commit olur, depo zamanla büyür.
- Durum `/healthz` içinde: `backup.lastSync`, `backup.lastError`.
- Ciddi trafik için gerçek bir veritabanı (Postgres) doğru çözümdür, bu bir ara çözümdür.

### Render'da kalıcı disk (alternatif)

SQLite dosyası diskte durur. Render ücretsiz planında disk **geçici**dir: her deploy ve yeniden başlatmada veriler silinir. Yedek yerine diski kalıcı yapmak için:

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
