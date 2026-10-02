# browsermcp-plus

**Yapay zekâ uygulamalarının kendi tarayıcını kullanmasını sağlar: tıklama, yazma, dosya yükleme, sekmeler, JavaScript.**

browsermcp-plus, bir [MCP](https://modelcontextprotocol.io) sunucusu ve açık kaynak bir Chrome eklentisidir. Claude, Cursor, VS Code gibi MCP istemcileri, bağladığın sekmede senin gerçek tarayıcı profilinle çalışır: oturumların açık kalır, hiçbir şey buluta gitmez, siteler normal bir tarayıcı görür.

[Browser MCP](https://github.com/BrowserMCP/mcp) projesinin güvenliği güçlendirilmiş bir çatalı olarak başladı ve onun eklentisiyle uyumludur.

## Kurulum

**1. Eklenti:** [Son sürümden](https://github.com/Novpix/browsermcp-plus/releases/latest) `browsermcp-plus-extension-*.zip` dosyasını indirip aç. Chrome'da:

1. `chrome://extensions` sayfasını aç, sağ üstten **Geliştirici modu**nu aç.
2. **Paketlenmemiş öğe yükle**ye tıkla ve açtığın klasörü seç.
3. Orijinal Browser MCP eklentisi kuruluysa onu kapat.

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

**3. Bağlan:** Otomatikleştirmek istediğin sekmede eklenti simgesine tıkla (<kbd>Alt</kbd>+<kbd>J</kbd>) ve **Connect**'e bas. Simgede `ON` yazısı görünür.

## Öne çıkanlar

- **Dosya yükleme:** Hem dosya alanlarına hem "dosya seç" butonlarına çalışır, işletim sisteminin dosya penceresi açılmaz.
- **Ek araçlar:** JavaScript çalıştırma, sekme yönetimi, kaydırma.
- **Güvenlik:** Sunucu yalnızca bu bilgisayardan erişilebilir ve web sayfaları sunucuya bağlanamaz.
- **Birden fazla istemci:** Aynı anda açıldığında portu kibarca devrederler, birbirlerini öldürmezler.
- **Test edilmiş:** Gerçek tarayıcıda uçtan uca testlerden geçer.

Araç listesi ve ayrıntılar için [İngilizce README](README.md).

## Lisans

Apache-2.0. [Browser MCP](https://github.com/BrowserMCP/mcp) tabanlıdır, onun geliştiricileriyle bağlantısı yoktur. Bkz. [NOTICE](NOTICE).
