# browsermcp-plus

**Yapay zekâ uygulamalarının kendi tarayıcını kullanmasını sağlar: tıklama, yazma, dosya yükleme, sekmeler, JavaScript.**

browsermcp-plus, bir [MCP](https://modelcontextprotocol.io) sunucusu ve açık kaynak bir Chrome eklentisidir. Claude, Cursor, VS Code gibi MCP istemcileri senin gerçek Chrome'unda, istediğin profilde çalışır: oturumların açık kalır, hiçbir şey buluta gitmez, siteler normal bir tarayıcı görür. Ajanlar kendi sekmelerinde çalışır ve işleri bitince bu sekmeler kapanır.

[Browser MCP](https://github.com/BrowserMCP/mcp) projesinin güvenliği güçlendirilmiş bir çatalı olarak başladı ve onun eklentisiyle uyumludur.

> **Kullanım riski sana aittir.** Ajanlar tarayıcında senin oturumlarınla çalışır ve orada senin yapabildiğin her şeyi yapabilir. Kullanmadan önce [sorumluluk reddini](#sorumluluk-reddi) oku.

## Kurulum

**1. Eklenti:** [Son sürümden](https://github.com/Novpix/browsermcp-plus/releases/latest) `browsermcp-plus-extension-*.zip` dosyasını indirip aç. Chrome'da:

1. `chrome://extensions` sayfasını aç, sağ üstten **Geliştirici modu**nu aç.
2. **Paketlenmemiş öğe yükle**ye tıkla ve açtığın klasörü seç.
3. Orijinal Browser MCP eklentisi kuruluysa onu kapat.

Ajanların kullanacağı her Chrome profiline ayrı ayrı yükle; her profildeki kopya kendisi bağlanır.

**2. Sunucu:** MCP istemcine ekle (Node.js 18+ gerekir):

```json
{
  "mcpServers": {
    "browser": { "command": "npx", "args": ["-y", "github:Novpix/browsermcp-plus"] }
  }
}
```

Claude Code için: `claude mcp add browser -- npx -y github:Novpix/browsermcp-plus`

Alternatif: Sürüm sayfasındaki tek dosyalık `browsermcp-plus.cjs`'i indirip `"command": "node", "args": ["/yol/browsermcp-plus.cjs"]` olarak kullan.

**3. Hazır:** Eklenti sunucuya kendisi bağlanır, ajanlar arka planda kendi sekmelerini açar. Açık bir sekmeni ajanlara vermek istersen o sekmede eklenti simgesine tıkla (<kbd>Alt</kbd>+<kbd>J</kbd>) ve **Connect**'e bas; simgede `ON` görünür.

## Öne çıkanlar

- **Dosya yükleme:** Hem dosya alanlarına hem "dosya seç" butonlarına çalışır, işletim sisteminin dosya penceresi açılmaz.
- **Hızlı ve tutumlu:** Tıklama gibi işlemler ~100 ms sürer ve tüm sayfa yerine kısa bir rapor döner (Wikipedia'da ~14.000 yerine ~30 token). Formlar `browser_fill_form` ile tek çağrıda doldurulur.
- **Çoklu ajan:** Her Claude Code oturumu ayrı bir ajandır ve kendi sekmesinde paralel çalışır. Bağladığın boş bir sekme varsa onu alır, yoksa arka planda kendi sekmesini açar. Ajan sekmeleri, kaç ajan çalışırsa çalışsın profil başına tek bir **AI** sekme grubunda durur; senin sekmelerin gruba girmez. Ajanlar birbirinin sekmesine, sen bağlamadıkça senin sekmelerine dokunamaz.
- **Ekranın kaymaz:** Ajanın yaptığı hiçbir şey hangi pencerede olursa olsun baktığın sekmeyi değiştirmez: sekme açmak, senin sekmeni alıp geri vermek, AI grubunu sağa almak, sayfasının yeni sekmede açtığı bağlantılar (arkada açılır). Hiçbir araç sekmenin önde olmasını gerektirmez; tıklama, yazma ve ekran görüntüsü arka plandaki sekmede çalışır. İzlemek istersen sekmeye kendin geçersin.
- **Çalıştığı belli:** Ajanın çalıştığı sayfanın kenarlarında ince, yumuşak bir parlama, köşede ajanın adı ve ne yaptığı ("okuyor", "yazıyor", "tıklıyor") görünür. Tıklamayı engellemez, düzeni bozmaz, ekran görüntüsüne ve snapshot'a girmez; ajan durunca söner.
- **İzle ya da dur de:** Ajanın sekmesine geçmek, kaydırmak, fareyi gezdirmek hiçbir şeyi değiştirmez, ajan sürer. Sayfanın içine tıklarsan ya da yazarsan ajan o sekmede durur ("Durdum · seni dinliyorum"), ne istediğini sorar; söyleyince `browser_tab_select` ile kaldığı yerden devam eder.
- **Sende:** Giriş, captcha, onay gibi senin yapman gereken bir şey olunca ajan sekmeyi `browser_tab_handoff` ile sana bırakır: sekme gruptan çıkar, kapanmaz, köşesinde "Sende: …" yazar; sayfanın içine tıklayana ya da yazana kadar (bakmak yetmez) başlığı ve simgesi yanıp söner, eklenti simgesi bekleyenleri sayar.
- **"Şu sekmede devam et":** `browser_tab_take` ile ajan açık bir sekmeni, sen ona girmeden alır: sayfa yeniden yüklenmez, yazdıkların ve kaydırma yerinde kalır, sekme AI grubuna geçer, Chrome bir kez "Geri ver" düğmeli bildirim gösterir. Sekme senindir: kapanmaz, iş bitince (`browser_tab_release`) eski penceresine ve yerine döner. Baktığın sekme önde kalır: başka bir penceredeyse gruba taşınmaz, orada kalır; izlemek için geçtiğin sekme de geri verilince olduğu yerde kalır.
- **AI grubu en sağda:** Grup sekme çubuğunun en sağında durur; senin sekmelerin solda, kendi sıralarında kalır.
- **İş bitince sekme kapanır:** Ajanın açtığı sekmeler, sayfasının açtıkları (yeni sekmede açılan bağlantılar, açılır pencereler) dahil, oturumu bitince kapanır. Sunucu haber vermeden ölürse 10 saniye içinde sunucu geri gelmezse kapanır. Bağladığın sekmeler hiç kapanmaz; ajanın açtığı bir sekmeyi tutmak için o sekmede eklenti simgesine tıklayıp **Keep this tab**'e bas.
- **Chrome profilleri:** `browser_profiles` profilleri (klasör, ad, Google hesabı) ve bağlı olanları listeler; `browser_profile_select` başka bir profile geçer, profilin penceresi yoksa açar. Hesabı olmayan profil, ilk açılışta tek kullanımlık bir sayfayla tanınır ve eklenti bunu hatırlar.
- **Çerçeveler ve uzun metin:** Başka sitelerden gelen çerçeveler (ödeme formu, gömülü giriş, sohbet kutusu) ve kapalı shadow DOM da okunur, tıklanır, yazılır. `browser_get_text` ileti gövdesi ya da makale gibi uzun metni Markdown olarak, kesmeden ve sayfa sayfa verir.
- **Debugger yalnız gerektiğinde:** Okuma (snapshot, arama, metin, konsol ve ağ hataları, gezinme) debugger'sız çalışır; Chrome'un "hata ayıklanıyor" çubuğu yalnız ajan tıklarken ya da yazarken görünür.
- **Dosyalar:** `browser_get_file` PDF, resim ya da herhangi bir dosyayı tarayıcının oturumlarıyla alır; `browser_download` / `browser_downloads` indirir ve nereye kaydedildiğini söyler.
- **Şifre yok:** Ajanlar şifre alanına yazmaz ve şifre okumaz; sekmeyi sana bırakır.
- **Takılmaz:** alert/confirm pencereleri yakalanır ve yönetilir; üstü kapalı ya da pasif butona tıklama, sebebi söylenerek reddedilir; tıklamayla açılan yeni sekmeler bildirilir.
- **Ek araçlar:** JavaScript çalıştırma, sekme yönetimi, kaydırma.
- **Güvenlik:** Sunucu yalnızca bu bilgisayardan erişilebilir ve web sayfaları sunucuya bağlanamaz.
- **Birden fazla istemci:** Aynı anda açıldığında portu kibarca devrederler, birbirlerini öldürmezler.
- **Test edilmiş:** Gerçek tarayıcıda uçtan uca testlerden geçer.

Araç listesi ve ayrıntılar için [İngilizce README](README.md).

## Sorumluluk reddi

browsermcp-plus güçlü bir araçtır: yapay zekâ ajanlarına, hesaplarına giriş yapılmış gerçek tarayıcının denetimini verir. Ulaşabildiği sekmelerde bir ajan senin yapabildiğin her şeyi yapabilir: mesaj ve e-posta gönderir, herkese açık paylaşım yapar, hesap ayarlarını değiştirir, veri siler, form gönderir, satın alır ve ödeme yapar. Yapay zekâ modelleri hata yapar; web sayfaları da onları yanıltmak için yazılmış metinler içerebilir (prompt injection).

- **Kullanımın sorumluluğu sana aittir.** Ajanları, profilleri ve siteleri sen seçersin. Onunla yapılan her işlemden, kullandığın sitelerin kurallarına ve sana uygulanan yasalara uymaktan yalnız sen sorumlusun.
- **Denetimi elinde tut.** Ajanların ne yaptığını izle, önemli her adımı kendin onayla. Değişmesini, silinmesini ya da açığa çıkmasını göze alamayacağın hesap ve verilerle kullanma.
- **Garanti yok, sorumluluk yok.** Yazılım "olduğu gibi", açık ya da örtük hiçbir garanti olmadan sunulur. Yasaların izin verdiği en geniş ölçüde Novpix LLC ve katkıda bulunanlar; kullanımından ya da ajanların onunla yaptığı işlemlerden doğan hiçbir zarardan, veri ya da para kaybından, hesap kapatılmasından veya başka bir sonuçtan sorumlu değildir. Bkz. [Apache Lisansı 2.0](LICENSE) madde 7 ve 8.
- **Bağımsız proje.** browsermcp-plus; Google, Anthropic, Browser MCP geliştiricileri ya da birlikte çalıştığı ürünlerin sahibi başka bir şirketle bağlantılı değildir, onlarca onaylanmamıştır. Chrome, Google LLC'nin markasıdır.

Bağlayıcı metin [İngilizce README](README.md#disclaimer) ve [LICENSE](LICENSE) dosyasıdır.

## Lisans

Telif hakkı 2026 Novpix LLC. Apache-2.0. [Browser MCP](https://github.com/BrowserMCP/mcp) tabanlıdır, onun geliştiricileriyle bağlantısı yoktur. Bkz. [NOTICE](NOTICE).
