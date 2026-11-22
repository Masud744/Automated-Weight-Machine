const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx > 0) {
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      process.env[key] = val;
    }
  }
}
loadEnv();

const app = express();
const port = parseInt(process.env.PORT, 10) || 3000;
const uploadDir = path.join(__dirname, "uploads");
const dbPath = path.join(__dirname, "measurements.json");

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, "[]");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = (supabaseUrl && supabaseKey)
  ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })
  : null;

app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(uploadDir));

function readLocalDb() {
  try {
    return JSON.parse(fs.readFileSync(dbPath, "utf8"));
  } catch {
    return [];
  }
}

function writeLocalDb(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

async function syncToSupabase(record, buffer) {
  if (!supabase) return null;

  try {
    const filename = `${record.measurementId}.jpg`;
    const { error: uploadError } = await supabase.storage
      .from("weight-images")
      .upload(filename, buffer, {
        contentType: "image/jpeg",
        upsert: true,
      });

    if (uploadError) {
      console.warn("Supabase storage upload failed:", uploadError.message);
    }

    const { data: publicUrlData } = supabase.storage
      .from("weight-images")
      .getPublicUrl(filename);

    const cloudImageUrl = publicUrlData?.publicUrl || record.imageUrl;

    const { error: dbError } = await supabase.from("measurements").upsert({
      id: record.measurementId,
      weight_grams: record.weightGrams,
      weight_kg: record.weightKg,
      image_url: cloudImageUrl,
      stability_status: record.stabilityStatus,
      capture_status: record.captureStatus,
      device_id: record.deviceId,
      trigger_type: record.triggerType || "auto",
      created_at: record.timestamp,
    });

    if (dbError) {
      console.warn("Supabase db insert failed:", dbError.message);
    }

    return cloudImageUrl;
  } catch (err) {
    console.error("Supabase sync error:", err.message);
    return null;
  }
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    supabaseConfigured: Boolean(supabase),
    supabaseUrl: supabaseUrl || null,
    timestamp: new Date().toISOString(),
  });
});

const { exec } = require("child_process");
const http = require("http");

function sendSerialCommand(cmd) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync("/dev/ttyACM0")) {
      return reject(new Error("Serial port /dev/ttyACM0 not present"));
    }
    const py = `import serial, time; s = serial.Serial('/dev/ttyACM0', 115200, timeout=1, dsrdtr=False, rtscts=False); s.write(b'${cmd}\\n'); time.sleep(0.1); s.close()`;
    exec(`python3 -c "${py}"`, (err, stdout) => {
      if (err) return reject(err);
      resolve({ ok: true, stdout });
    });
  });
}

let currentEspIp = "172.16.114.193";

function resolveTargetIp(req) {
  if (req && req.query && req.query.ip && req.query.ip.trim()) {
    return req.query.ip.trim();
  }
  return currentEspIp;
}

app.get("/api/esp-ip", (_req, res) => {
  res.json({ ip: currentEspIp });
});

app.post("/api/esp-ip", express.json(), (req, res) => {
  if (req.body && req.body.ip && typeof req.body.ip === "string") {
    currentEspIp = req.body.ip.trim();
    return res.json({ ok: true, ip: currentEspIp });
  }
  res.status(400).json({ error: "Missing or invalid ip" });
});

app.get("/api/esp-live", async (req, res) => {
  const targetIp = resolveTargetIp(req);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const espRes = await fetch(`http://${targetIp}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (espRes.ok) {
      const data = await espRes.json();
      return res.json(data);
    }
  } catch {}

  if (fs.existsSync("/dev/ttyACM0")) {
    try {
      const py = `import serial, time; s = serial.Serial('/dev/ttyACM0', 115200, timeout=0.5, dsrdtr=False, rtscts=False); s.write(b'h\\n'); time.sleep(0.2); out = s.read(s.in_waiting or 200).decode('utf-8', errors='ignore'); s.close(); print(out)`;
      const { execSync } = require("child_process");
      const out = execSync(`python3 -c "${py}"`, { timeout: 1200 }).toString();
      const match = out.match(/Weight:\s*([-\d.]+)\s*g/i);
      const wt = match ? parseFloat(match[1]) : 0.0;
      return res.json({ status: "online", camera: true, scale: true, weight: wt, calibration: 420.0, method: "serial" });
    } catch {}
  }

  res.status(504).json({ error: "Cannot reach ESP32" });
});

app.get("/api/esp-tare", async (req, res) => {
  const targetIp = resolveTargetIp(req);
  if (fs.existsSync("/dev/ttyACM0")) {
    try {
      await sendSerialCommand("t");
      return res.json({ ok: true, tare: true, method: "serial" });
    } catch (e) {
      console.warn("Serial tare failed:", e.message);
    }
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const espRes = await fetch(`http://${targetIp}/tare`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!espRes.ok) return res.status(502).json({ error: "ESP32 tare failed" });
    const data = await espRes.json();
    res.json(data);
  } catch (err) {
    res.status(504).json({ error: "Cannot reach ESP32", details: err.message });
  }
});

app.get("/api/esp-trigger", async (req, res) => {
  const targetIp = resolveTargetIp(req);
  const trigType = (req.query.type || "manual").trim();

  try {
    let weight = 0.0;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1200);
      const hRes = await fetch(`http://${targetIp}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (hRes.ok) {
        const hData = await hRes.json();
        if (Number.isFinite(hData.weight)) weight = Number(hData.weight);
      }
    } catch {}

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const imgRes = await fetch(`http://${targetIp}/capture`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!imgRes.ok) {
      return res.status(502).json({ error: `ESP32 capture returned status ${imgRes.status}` });
    }

    const buffer = Buffer.from(await imgRes.arrayBuffer());
    if (buffer.length < 100) {
      return res.status(502).json({ error: "Invalid JPEG frame received from ESP32" });
    }

    const id = crypto.randomUUID();
    const localFile = `${id}.jpg`;
    fs.writeFileSync(path.join(uploadDir, localFile), buffer);

    const record = {
      measurementId: id,
      weightGrams: weight,
      weightKg: parseFloat((weight / 1000).toFixed(4)),
      imageUrl: `/uploads/${localFile}`,
      timestamp: new Date().toISOString(),
      stabilityStatus: "stable",
      captureStatus: "saved",
      deviceId: "smart-scale-01",
      triggerType: trigType,
    };

    const cloudUrl = await syncToSupabase(record, buffer);
    if (cloudUrl) {
      record.cloudImageUrl = cloudUrl;
    }

    const all = readLocalDb();
    all.unshift(record);
    writeLocalDb(all);

    // Notify ESP32 trigger endpoint for display state update
    fetch(`http://${targetIp}/trigger?type=${encodeURIComponent(trigType)}`, {
      signal: AbortSignal.timeout(1000),
    }).catch(() => {});

    return res.status(201).json({ ok: true, measurement: record });
  } catch (err) {
    console.error("Direct capture failed:", err.message);
    return res.status(504).json({ error: "Cannot capture from ESP32", details: err.message });
  }
});

app.get("/api/stream", (req, res) => {
  const targetIp = resolveTargetIp(req);
  const proxyReq = http.get(`http://${targetIp}:81/stream`, (streamRes) => {
    res.writeHead(streamRes.statusCode, streamRes.headers);
    streamRes.pipe(res);
  });
  proxyReq.on("error", () => res.status(502).end());
  req.on("close", () => proxyReq.destroy());
});

app.get("/api/measurements", async (_req, res) => {
  if (supabase) {
    const { data, error } = await supabase
      .from("measurements")
      .select("*")
      .order("created_at", { ascending: false });

    if (!error && Array.isArray(data)) {
      const formatted = data.map((row) => ({
        measurementId: row.id,
        weightGrams: row.weight_grams,
        weightKg: row.weight_kg,
        imageUrl: row.image_url,
        stabilityStatus: row.stability_status,
        captureStatus: row.capture_status,
        deviceId: row.device_id,
        triggerType: row.trigger_type || "auto",
        timestamp: row.created_at,
      }));
      return res.json(formatted);
    }
  }

  const local = readLocalDb().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(local);
});

app.post(
  "/api/upload-image",
  express.raw({ type: "image/jpeg", limit: "10mb" }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length < 16) {
      return res.status(400).json({ error: "Valid JPEG body required" });
    }

    const id = (req.get("X-Measurement-ID") || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "_");
    const weight = parseFloat(req.get("X-Weight-Grams"));
    const deviceId = req.get("X-Device-ID") || "smart-scale-01";
    const triggerType = req.get("X-Trigger-Type") || "auto";

    const senderIp = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").replace(/^.*:/, "").trim();
    if (senderIp && senderIp !== "127.0.0.1" && senderIp !== "localhost") {
      currentEspIp = senderIp;
    }

    if (!Number.isFinite(weight)) {
      return res.status(400).json({ error: "Invalid or missing X-Weight-Grams header" });
    }

    const localFile = `${id}.jpg`;
    fs.writeFileSync(path.join(uploadDir, localFile), req.body);

    const record = {
      measurementId: id,
      weightGrams: weight,
      weightKg: parseFloat((weight / 1000).toFixed(4)),
      imageUrl: `/uploads/${localFile}`,
      timestamp: new Date().toISOString(),
      stabilityStatus: "stable",
      captureStatus: "saved",
      deviceId,
      triggerType,
    };

    const cloudUrl = await syncToSupabase(record, req.body);
    if (cloudUrl) {
      record.cloudImageUrl = cloudUrl;
    }

    const all = readLocalDb();
    const existingIndex = all.findIndex((m) => m.measurementId === id);
    if (existingIndex >= 0) {
      all[existingIndex] = record;
    } else {
      all.unshift(record);
    }
    writeLocalDb(all);

    res.status(201).json({ ok: true, measurement: record });
  }
);

app.delete("/api/measurements/:id", async (req, res) => {
  const { id } = req.params;

  if (supabase) {
    await supabase.from("measurements").delete().eq("id", id);
    await supabase.storage.from("weight-images").remove([`${id}.jpg`]);
  }

  const all = readLocalDb().filter((m) => m.measurementId !== id);
  writeLocalDb(all);

  const localFile = path.join(uploadDir, `${id}.jpg`);
  if (fs.existsSync(localFile)) {
    try {
      fs.unlinkSync(localFile);
    } catch {}
  }

  res.json({ ok: true, id });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${port}`);
  if (supabase) {
    console.log(`Connected to Supabase: ${supabaseUrl}`);
  }
});
