export function ActionGrid() {
  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", background: "#f1f5f9", minHeight: "100vh", width: "100%" }}>
      {/* Hero balance area */}
      <div style={{ background: "linear-gradient(160deg, #024959 0%, #593E25 100%)", padding: "20px 16px 28px", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: -40, left: -40, width: 160, height: 160, borderRadius: "50%", background: "rgba(255,255,255,0.05)" }} />
        <div style={{ position: "absolute", bottom: -20, right: -20, width: 100, height: 100, borderRadius: "50%", background: "rgba(242,193,46,0.18)" }} />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20, position: "relative" }}>
          <div>
            <p style={{ margin: 0, color: "rgba(255,255,255,0.6)", fontSize: 12, letterSpacing: 0.8 }}>KEMDATAPLUS</p>
            <p style={{ margin: "2px 0 0", color: "rgba(255,255,255,0.9)", fontSize: 14, fontWeight: 500 }}>Wallet</p>
          </div>
          <div style={{ background: "#F2C12E", borderRadius: 8, padding: "4px 10px", fontSize: 11, fontWeight: 700, color: "#024959" }}>● ACTIVE</div>
        </div>

        <div style={{ position: "relative" }}>
          <p style={{ margin: "0 0 4px", color: "rgba(255,255,255,0.55)", fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase" }}>Available Balance</p>
          <div id="walletBalance" style={{ fontSize: 36, fontWeight: 800, color: "white", letterSpacing: -1 }}>GHS 0.00</div>
        </div>
      </div>

      {/* Stats row — overlapping the hero slightly */}
      <div style={{ display: "flex", gap: 10, padding: "0 14px", marginTop: -14 }}>
        <div style={{ flex: 1, background: "white", borderRadius: 12, padding: "12px 14px", boxShadow: "0 4px 16px rgba(0,0,0,0.08)", borderTop: "3px solid #024959" }}>
          <p style={{ margin: "0 0 4px", fontSize: 10, color: "#9ca3af", fontWeight: 500, textTransform: "uppercase", letterSpacing: 0.6 }}>Total Spent</p>
          <div id="totalSpent" style={{ fontSize: 18, fontWeight: 700, color: "#024959" }}>GHS 0.00</div>
        </div>
        <div style={{ flex: 1, background: "white", borderRadius: 12, padding: "12px 14px", boxShadow: "0 4px 16px rgba(0,0,0,0.08)", borderTop: "3px solid #F2C12E" }}>
          <p style={{ margin: "0 0 4px", fontSize: 10, color: "#9ca3af", fontWeight: 500, textTransform: "uppercase", letterSpacing: 0.6 }}>This Month</p>
          <div id="thisMonthSpent" style={{ fontSize: 18, fontWeight: 700, color: "#593E25" }}>GHS 0.00</div>
        </div>
      </div>

      {/* Action Grid — 2×2 */}
      <div style={{ padding: "16px 14px 0" }}>
        <p style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1 }}>Quick Actions</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {[
            { icon: "📦", label: "Buy Bundles", sub: "MTN, Telecel, AT", bg: "#024959", fg: "white", accent: "#F2C12E" },
            { icon: "📋", label: "View Orders", sub: "Track your orders", bg: "white", fg: "#024959", accent: "#024959" },
            { icon: "📱", label: "Claim MoMo", sub: "MoMo cashback", bg: "#F2C12E", fg: "#024959", accent: "#024959" },
            { icon: "💸", label: "Send Funds", sub: "Transfer to friends", bg: "white", fg: "#593E25", accent: "#593E25" },
          ].map(({ icon, label, sub, bg, fg, accent }) => (
            <button key={label} style={{ background: bg, border: bg === "white" ? "1px solid #e5e7eb" : "none", borderRadius: 14, padding: "16px 14px", textAlign: "left", cursor: "pointer", boxShadow: bg !== "white" ? "0 4px 14px rgba(0,0,0,0.12)" : "none" }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: bg === "white" ? "#f3f4f6" : "rgba(255,255,255,0.18)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, marginBottom: 10 }}>{icon}</div>
              <p style={{ margin: "0 0 2px", fontSize: 13, fontWeight: 700, color: fg }}>{label}</p>
              <p style={{ margin: 0, fontSize: 10, color: bg === "white" ? "#9ca3af" : `rgba(255,255,255,0.65)` }}>{sub}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Services Tabs */}
      <div style={{ padding: "18px 14px 0" }}>
        <p style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1 }}>Services</p>
        <div style={{ display: "flex", gap: 6, overflowX: "auto", scrollbarWidth: "none" }}>
          {["Top Up", "Earnings", "History"].map((tab, i) => (
            <button key={tab} style={{ flex: "0 0 auto", padding: "7px 16px", fontSize: 12, fontWeight: i === 0 ? 700 : 500, color: i === 0 ? "#024959" : "#6b7280", background: i === 0 ? "#e0f2fe" : "white", border: "1px solid " + (i === 0 ? "#bae6fd" : "#e5e7eb"), borderRadius: 8, cursor: "pointer" }}>
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ margin: "12px 14px 0", background: "white", borderRadius: 14, padding: "18px 16px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
        <h3 style={{ margin: "0 0 14px", fontSize: 14, fontWeight: 700, color: "#111827" }}>Instant Top Up</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {["Select Network", "Phone Number", "Select Bundle"].map((label) => (
            <div key={label}>
              <label style={{ fontSize: 12, color: "#4b5563", fontWeight: 500, display: "block", marginBottom: 4 }}>{label}</label>
              <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 12px", fontSize: 13, color: "#9ca3af" }}>Tap to select...</div>
            </div>
          ))}
        </div>
        <button style={{ width: "100%", marginTop: 14, background: "linear-gradient(135deg, #024959, #593E25)", border: "none", borderRadius: 10, padding: "13px", fontWeight: 700, fontSize: 14, color: "white", cursor: "pointer" }}>
          Continue
        </button>
      </div>

      <div style={{ height: 24 }} />
    </div>
  );
}
