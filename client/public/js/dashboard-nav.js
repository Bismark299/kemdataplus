// dashboard-nav.js
// Handles sidebar navigation and logout for admin dashboard (CSP-compliant)

document.addEventListener('DOMContentLoaded', function () {
    // Sidebar nav links
    const navLinks = document.querySelectorAll('.nav-link');
    const sectionMap = {
        dashboard: [
            document.querySelector('.main-stats'),
            document.querySelector('.status-cards'),
            document.querySelector('.filters-section'),
            document.querySelector('.network-tabs'),
            document.querySelector('.action-bar'),
            document.querySelector('.table-container')
        ],
        wallet: document.getElementById('walletSection'),
        users: document.getElementById('usersSection'),
        history: document.getElementById('historySection'),
        networks: document.getElementById('networksSection'),
        reports: document.getElementById('reportsSection'),
        settings: document.getElementById('settingsSection')
    };

    function hideAllSections() {
        // Hide dashboard elements
        sectionMap.dashboard.forEach(el => { if (el) el.style.display = 'none'; });
        // Hide all main sections
        ['wallet', 'users', 'history', 'networks', 'reports', 'settings'].forEach(key => {
            const sec = sectionMap[key];
            if (sec) sec.classList.remove('active');
        });
    }

    function showSection(section) {
        hideAllSections();
        if (section === 'dashboard') {
            sectionMap.dashboard.forEach(el => { if (el) el.style.display = ''; });
        } else if (sectionMap[section]) {
            sectionMap[section].classList.add('active');
        }
    }

    navLinks.forEach(link => {
        link.addEventListener('click', function (e) {
            e.preventDefault();
            navLinks.forEach(l => l.classList.remove('active'));
            this.classList.add('active');
            const section = this.getAttribute('data-section');
            showSection(section);
        });
    });

    // Logout button (calls API to clear httpOnly cookie)
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async function () {
            try {
                await fetch('/api/auth/logout', {
                    method: 'POST',
                    credentials: 'include'
                });
            } catch (e) {
                // Ignore errors
            }
            localStorage.removeItem('adminLoggedIn');
            localStorage.removeItem('adminUser');
            localStorage.removeItem('currentUser');
            window.location.href = '../pages/login.html';
        });
    }
});
