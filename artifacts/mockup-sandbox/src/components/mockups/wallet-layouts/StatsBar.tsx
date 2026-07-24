export function StatsBar() {
  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", background: "#f8fafc", minHeight: "100vh", width: "100%" }}>
      {/* Compact dark header */}
      <div style={{ background: "#013844", padding: "0 0 20px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px 0" }}>
          <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 13 }}>My Wallet</span>
          <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#F2C12E", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: "#013844" }}>K</div>
        </div>

        <div style={{ textAlign: "center", padding: "18px 16px 0" }}>
          <p style={{ margin: "0 0 6px", fontSize: 12, color: "rgba(255,255,255,0.55)", letterSpacing: 0.8, textTransform: "uppercase" }}>Balance</p>
          <div id="walletBalance" style={{ fontSize: 42, fontWeight: 800, color: "white", letterSpacing: -2 }}>GHS 0.00</div>
          <span style={{ display: "inline-block", marginTop: 8, background: "rgba(167,243,208,0.15)", color: "#6ee7b7", fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 20, letterSpacing: 0.5 }}>● Active</span>
        </div>
      </div>

      {/* Stats Bar — horizontal scroll on very small screens */}
      <div style={{ display: "flex", gap: 10, padding: "14px 14px 0", overflowX: "auto", scrollbarWidth: "none" }}>
        {[
          { id: "totalSpent", label: "Total Spent", value: "GHS 0.00", icon: "📊", color: "#eff6ff", border: "#bfdbfe", text: "#1e40af" },
          { id: "thisMonthSpent", label: "This Month", value: "GHS 0.00", icon: "📅", color: "#f0fdf4", border: "#bbf7d0", text: "#15803d" },
          { id: "debt", label: "Outstanding", value: "GHS 0.00", icon: "⚠️", color: "#fff7ed", border: "#fed7aa", text: "#c2410c" },
        ].map(({ id, label, value, icon, color, border, text }) => (
          <div key={id} style={{ flex: "0 0 auto", minWidth: 130, background: color, border: `1px solid ${border}`, borderRadius: 12, padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <span style={{ fontSize: 16 }}>{icon}</span>
              <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 500 }}>{label}</span>
            </div>
            <div id={id} style={{ fontSize: 17, fontWeight: 700, color: text }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Quick Actions Row */}
      <div style={{ display: "flex", gap: 8, padding: "12px 14px 0" }}>
        {[
          { icon: "🛒", label: "Buy Bundles", bg: "#024959", fg: "white" },
          { icon: "📋", label: "View Orders", bg: "white", fg: "#024959" },
          { icon: "➕", label: "Add Funds", bg: "#F2C12E", fg: "#024959" },
        ].map(({ icon, label, bg, fg }) => (
          <button key={label} style={{ flex: 1, background: bg, border: bg === "white" ? "1px solid #e5e7eb" : "none", borderRadius: 10, padding: "10px 6px", color: fg, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 20 }}>{icon}</span>
            <span style={{ fontSize: 10, fontWeight: 600 }}>{label}</span>
          </button>
        ))}
      </div>

      {/* Section Label */}
      <div style={{ padding: "18px 14px 8px" }}>
        <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase", letterSpacing: 1 }}>Services</p>
      </div>

      {/* Tab Navigation — pill style */}
      <div style={{ padding: "0 14px", display: "flex", gap: 8, overflowX: "auto", scrollbarWidth: "none" }}>
        {["Instant Top Up", "Claim MoMo", "Send Funds", "Earnings", "History"].map((tab, i) => (
          <button key={tab} style={{ flex: "0 0 auto", padding: "8px 14px", fontSize: 12, fontWeight: i === 0 ? 600 : 500, color: i === 0 ? "white" : "#6b7280", background: i === 0 ? "#024959" : "white", border: i === 0 ? "none" : "1px solid #e5e7eb", borderRadius: 20, cursor: "pointer", whiteSpace: "nowrap" }}>
            {tab}
          </button>
        ))}
      </div>

      {/* Content Card */}
      <div style={{ margin: "12px 14px 0", background: "white", borderRadius: 14, padding: "18px 16px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 700, color: "#111827" }}>Instant Top Up</h3>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {[
            { label: "Select Network", placeholder: "MTN, Telecel, AT..." },
            { label: "Recipient Number", placeholder: "024XXXXXXX" },
            { label: "Select Bundle", placeholder: "1GB, 2GB, 5GB..." },
          ].map(({ label, placeholder }) => (
            <div key={label}>
              <label style={{ fontSize: 12, color: "#4b5563", fontWeight: 500, display: "block", marginBottom: 4 }}>{label}</label>
              <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 12px", fontSize: 13, color: "#9ca3af" }}>{placeholder}</div>
            </div>
          ))}
        </div>

        <button style={{ width: "100%", marginTop: 16, background: "#024959", border: "none", borderRadius: 10, padding: "13px", fontWeight: 700, fontSize: 14, color: "white", cursor: "pointer" }}>
          Proceed →
        </button>
      </div>

      <div style={{ height: 24 }} />
    </div>
  );
}
