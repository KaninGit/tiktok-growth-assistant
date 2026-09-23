# TikTok Growth Assistant

แอป Windows (Electron) สำหรับดูสถิติและวางแผนคอนเทนต์ของบัญชี TikTok **ของคุณเอง** ผ่าน API ทางการของ TikTok for Developers
ไม่มีการสร้างผู้ติดตามปลอม ไม่ใช้บอท และไม่ใช้ follow/unfollow อัตโนมัติ

## ฟีเจอร์

| หน้า | รายละเอียด |
|---|---|
| ภาพรวม | ผู้ติดตาม, +7/30 วัน, ยอดไลก์, ยอดวิว median, Engagement rate, กราฟแนวโน้มผู้ติดตามและการเปลี่ยนแปลงรายวัน, วิดีโอยอดนิยม |
| วิดีโอ | ตารางวิดีโอทั้งหมด ค้นหาและเรียงได้, คลิกเพื่อเปิดใน TikTok, Export CSV (เปิดใน Excel ภาษาไทยไม่เพี้ยน) |
| วิเคราะห์เชิงลึก | 5 ช่วงเวลาที่ดีที่สุดในการโพสต์, heatmap วัน × ชั่วโมง, วิวตามวัน/ชั่วโมง, ประสิทธิภาพแฮชแท็ก, ประสิทธิภาพตามความยาววิดีโอ, คลิปที่ engagement สูงสุด |
| ตั้งเวลาโพสต์ | เลือกหรือลากไฟล์วิดีโอมาวาง, แคปชัน, โพสต์ตรง (Direct Post) หรือส่งเข้ากล่องร่าง, ตั้งค่าความเป็นส่วนตัว/คอมเมนต์/Duet/Stitch, เปิดเผยเนื้อหาเชิงพาณิชย์, ปุ่ม "ใช้เวลาที่แนะนำ", คิวพร้อมสถานะและปุ่มลองใหม่ |
| ตั้งค่า | Client Key/Secret, redirect port, เชื่อมต่อ/ยกเลิกการเชื่อมต่อ, ซิงก์อัตโนมัติ, ย่อไว้ที่ System Tray, สลับภาษาไทย/อังกฤษ |

## ตั้งค่า TikTok Developer (ทำครั้งเดียว)

1. ไปที่ https://developers.tiktok.com แล้วสร้าง App โดยเลือก Platform เป็น **Desktop**
2. เพิ่ม **Login Kit** และ **Content Posting API** (เปิด Direct Post ด้วย)
3. เปิด scopes เหล่านี้: `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list`, `video.publish`, `video.upload`
4. ใส่ Redirect URI เป็น `http://127.0.0.1:3455/callback/` (ถ้าเปลี่ยน port ในแอป ต้องแก้ตรงนี้ให้ตรงกันด้วย)
5. เปิดแอป ไปที่ **ตั้งค่า** แล้วใส่ Client Key และ Client Secret กด **บันทึก** แล้วกด **เชื่อมต่อ TikTok**

> **ข้อจำกัดจาก TikTok:** แอปที่ยังไม่ผ่าน audit โพสต์ได้เฉพาะแบบ "เฉพาะฉัน" (`SELF_ONLY`) ถ้าจะโพสต์แบบสาธารณะ ต้องส่งแอปให้ TikTok audit ก่อน
> ส่วนที่ต้องทำตาม UX guideline ของ Direct Post มีครบในแอปแล้ว ได้แก่ แสดงชื่อบัญชีผู้โพสต์, ไม่ตั้งค่าความเป็นส่วนตัวไว้ล่วงหน้า, toggle ต่าง ๆ ปิดไว้เป็นค่าเริ่มต้น, มีการเปิดเผยเนื้อหาเชิงพาณิชย์ และข้อความยินยอม

## รันและ build บน Windows

ต้องมี Node.js 20 ขึ้นไป

```powershell
npm install
npm start           # รันโหมดพัฒนา
npm test            # smoke tests (ไม่ต้องใช้ Electron)
npm run dist        # ได้ไฟล์ติดตั้ง (NSIS) + Portable .exe ในโฟลเดอร์ dist\
npm run dist:portable
```

## สถาปัตยกรรม

```
src/main/
  main.js        หน้าต่าง, tray, IPC, จัดเก็บ secret ด้วย safeStorage (Windows DPAPI)
  oauth.js       Login Kit for Desktop: PKCE (hex SHA-256) + loopback server รอรับ callback
  tiktok-api.js  เรียก Display API และ Content Posting API, refresh token อัตโนมัติ, อัปโหลดแบบแบ่ง chunk
  sync.js        ดึงข้อมูลบัญชีและวิดีโอ แล้วเก็บ snapshot ลง SQLite
  scheduler.js   คิวโพสต์: ตรวจ creator_info ซ้ำก่อนโพสต์ → อัปโหลด → poll สถานะ
  analytics.js   ฟังก์ชันวิเคราะห์ล้วน ๆ (best time, hashtag, duration, growth, CSV)
  db.js          SQLite ผ่าน sql.js (WASM ไม่ต้องคอมไพล์ native module)
src/renderer/    UI (HTML/CSS/JS + Chart.js), i18n ไทย/อังกฤษ
```

- ข้อมูลเก็บที่ `%APPDATA%\TikTok Growth Assistant\tga.sqlite`
- Client Secret และ token ถูกเข้ารหัสด้วย Windows DPAPI
- Renderer ทำงานแบบ `contextIsolation` + `sandbox` + CSP และรับข้อมูลจาก main ผ่าน preload API ที่จำกัดไว้เท่านั้น
- โพสต์จะออกตามเวลาได้เฉพาะตอนที่แอปเปิดอยู่ (ย่อไว้ที่ System Tray ได้) ถ้าปิดแอประหว่างอัปโหลด โพสต์นั้นจะถูกตั้งเป็น "ล้มเหลว" และกดลองใหม่ได้
- กราฟผู้ติดตามสร้างจาก snapshot ที่แอปเก็บเอง (API ไม่มีประวัติย้อนหลังให้) กราฟจึงจะเริ่มมีข้อมูลหลังใช้งานไปได้ 2–3 วัน
