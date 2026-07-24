export function BankCard() {
  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", background: "#f0f4f8", minHeight: "100vh", width: "100%" }}>
      {/* Header / Top Nav */}
      <div style={{ background: "#024959", padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: "50%", background: "#F2C12E", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, color: "#024959", fontSize: 14 }}>K</div>
          <span style={{ color: "white", fontWeight: 600, fontSize: 16 }}>My Wallet</span>
        </div>
        <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 22 }}>&#9776;</div>
      </div>

      {/* Big Balance Card */}
      <div style={{ margin: "16px 14px 0", background: "linear-gradient(135deg, #024959 0%, #037a97 100%)", borderRadius: 18, padding: "24px 20px 20px", color: "white", position: "relative", overflow: "hidden", boxShadow: "0 8px 32px rgba(2,73,89,0.3)" }}>
        {/* decorative circles */}
        <div style={{ position: "absolute", top: -30, right: -30, width: 120, height: 120, borderRadius: "50%", background: "rgba(255,255,255,0.07)" }} />
        <div style={{ position: "absolute", bottom: -20, right: 30, width: 80, height: 80, borderRadius: "50%", background: "rgba(242,193,46,0.15)" }} />

        <p style={{ margin: "0 0 4px", fontSize: 12, opacity: 0.75, letterSpacing: 1, textTransform: "uppercase" }}>Available Balance</p>
        <div id="walletBalance" style={{ fontSize: 38, fontWeight: 800, letterSpacing: -1, marginBottom: 18 }}>GHS 0.00</div>

        {/* Inline stats row */}
        <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
          <div style={{ flex: 1, background: "rgba(255,255,255,0.12)", borderRadius: 10, padding: "10px 12px" }}>
            <p style={{ margin: 0, fontSize: 10, opacity: 0.7, letterSpacing: 0.5, textTransform: "uppercase" }}>Total Spent</p>
            <p id="totalSpent" style={{ margin: "4px 0 0", fontSize: 16, fontWeight: 700 }}>GHS 0.00</p>
          </div>
          <div style={{ flex: 1, background: "rgba(255,255,255,0.12)", borderRadius: 10, padding: "10px 12px" }}>
            <p style={{ margin: 0, fontSize: 10, opacity: 0.7, letterSpacing: 0.5, textTransform: "uppercase" }}>This Month</p>
            <p id="thisMonthSpent" style={{ margin: "4px 0 0", fontSize: 16, fontWeight: 700 }}>GHS 0.00</p>
          </div>
        </div>

        {/* Quick Action Buttons */}
        <div style={{ display: "flex", gap: 10 }}>
          {[
            { icon: "💳", label: "Top Up" },
            { icon: "📦", label: "Orders" },
            { icon: "💸", label: "Send" },
            { icon: "📈", label: "Earn" },
          ].map(({ icon, label }) => (
            <button key={label} style={{ flex: 1, background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 10, padding: "8px 4px", color: "white", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 18 }}>{icon}</span>
              <span style={{ fontSize: 10, fontWeight: 500 }}>{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Tab Bar */}
      <div style={{ margin: "14px 14px 0", background: "white", borderRadius: 12, overflow: "hidden", boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}>
        <div style={{ display: "flex", overflowX: "auto", scrollbarWidth: "none" }}>
          {["Instant Top Up", "Claim MoMo", "Send Funds", "Earnings", "History"].map((tab, i) => (
            <button key={tab} style={{ flex: "0 0 auto", padding: "12px 14px", fontSize: 12, fontWeight: i === 0 ? 700 : 500, color: i === 0 ? "#024959" : "#6b7280", background: "none", border: "none", borderBottom: i === 0 ? "2px solid #F2C12E" : "2px solid transparent", cursor: "pointer", whiteSpace: "nowrap" }}>
              {tab}
            </button>
          ))}
        </div>

        {/* Tab content area */}
        <div style={{ padding: "20px 16px" }}>
          <div style={{ textAlign: "center", padding: "10px 0 20px" }}>
            <div style={{ width: 56, height: 56, background: "#e6f4f7", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px", fontSize: 26 }}>💳</div>
            <p style={{ margin: "0 0 4px", fontWeight: 600, color: "#024959", fontSize: 15 }}>Instant Top Up</p>
            <p style={{ margin: 0, color: "#6b7280", fontSize: 13 }}>Buy MTN, Telecel, or AT data instantly</p>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[
              { label: "Network", type: "select", placeholder: "Select network" },
              { label: "Phone Number", type: "tel", placeholder: "024XXXXXXX" },
              { label: "Bundle", type: "select", placeholder: "Select bundle" },
            ].map(({ label, placeholder }) => (
              <div key={label}>
                <label style={{ fontSize: 12, color: "#374151", fontWeight: 500, display: "block", marginBottom: 4 }}>{label}</label>
                <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 12px", fontSize: 13, color: "#9ca3af" }}>{placeholder}</div>
              </div>
            ))}
          </div>

          <button style={{ width: "100%", marginTop: 16, background: "linear-gradient(135deg, #F2C12E, #F2AE30)", border: "none", borderRadius: 10, padding: "13px", fontWeight: 700, fontSize: 14, color: "#024959", cursor: "pointer" }}>
            Buy Bundle
          </button>
        </div>
      </div>

      {/* Bottom safe area */}
      <div style={{ height: 20 }} />
    </div>
  );
}
