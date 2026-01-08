// dashboard-actions.js
// Handles all admin dashboard button actions and modal controls (CSP-compliant)

document.addEventListener('DOMContentLoaded', function () {
        // Delegated event handler for all dynamic table actions
        document.body.addEventListener('click', function (e) {
            const target = e.target.closest('[data-action]');
            if (!target) return;
            const action = target.getAttribute('data-action');
            const id = target.getAttribute('data-id');
            switch (action) {
                case 'cancel-order':
                    if (id) window.cancelOrder && window.cancelOrder(id);
                    break;
                case 'complete-order':
                    if (id) window.completeOrder && window.completeOrder(id);
                    break;
                case 'view-order':
                    if (id) window.viewOrder && window.viewOrder(id);
                    break;
                case 'view-user':
                    if (id) window.viewUser && window.viewUser(id);
                    break;
                case 'edit-user':
                    if (id) window.editUser && window.editUser(id);
                    break;
                case 'change-role':
                    if (id) window.openChangeRoleModal && window.openChangeRoleModal(id);
                    break;
                case 'quick-fund':
                    if (id) window.quickFundUser && window.quickFundUser(id);
                    break;
                case 'delete-user':
                    if (id) window.deleteUser && window.deleteUser(id);
                    break;
                case 'toggle-bundle-status':
                    if (id) window.toggleBundleStatus && window.toggleBundleStatus(id);
                    break;
                case 'show-toast':
                    // For disabled toggles, show error toast
                    const msg = target.getAttribute('data-message') || 'Action not allowed';
                    const type = target.getAttribute('data-type') || 'error';
                    window.showToast && window.showToast(msg, type);
                    break;
                case 'edit-bundle-tariff':
                    if (id) window.editBundleTariff && window.editBundleTariff(id);
                    break;
                case 'delete-bundle-tariff':
                    if (id) window.deleteBundleTariff && window.deleteBundleTariff(id);
                    break;
                // Add more cases as needed for other actions
            }
        });
    // Network filter buttons
    const filterBtnMTN = document.getElementById('filterBtnMTN');
    const filterBtnTelecel = document.getElementById('filterBtnTelecel');
    const filterBtnAirtelTigo = document.getElementById('filterBtnAirtelTigo');
    if (filterBtnMTN) filterBtnMTN.addEventListener('click', () => quickFilterNetwork('MTN'));
    if (filterBtnTelecel) filterBtnTelecel.addEventListener('click', () => quickFilterNetwork('Telecel'));
    if (filterBtnAirtelTigo) filterBtnAirtelTigo.addEventListener('click', () => quickFilterNetwork('AirtelTigo'));

    // Bulk actions
    const bulkCompleteBtn = document.getElementById('bulkCompleteBtn');
    const bulkCancelBtn = document.getElementById('bulkCancelBtn');
    if (bulkCompleteBtn) bulkCompleteBtn.addEventListener('click', bulkComplete);
    if (bulkCancelBtn) bulkCancelBtn.addEventListener('click', bulkCancel);

    // Select all checkbox
    const selectAll = document.getElementById('selectAll');
    if (selectAll) selectAll.addEventListener('change', toggleSelectAll);

    // Add payment
    const addPaymentBtn = document.getElementById('addPaymentBtn');
    if (addPaymentBtn) addPaymentBtn.addEventListener('click', openAddPaymentModal);

    // Per page select
    const tablePerPage = document.getElementById('tablePerPage');
    if (tablePerPage) tablePerPage.addEventListener('change', renderIncomingPayments);

    // Add user
    const addUserBtn = document.getElementById('addUserBtn');
    if (addUserBtn) addUserBtn.addEventListener('click', openAddUserModal);

    // Modal close/cancel buttons
    const closeUserModalBtn = document.getElementById('closeUserModalBtn');
    const cancelUserModalBtn = document.getElementById('cancelUserModalBtn');
    if (closeUserModalBtn) closeUserModalBtn.addEventListener('click', closeUserModal);
    if (cancelUserModalBtn) cancelUserModalBtn.addEventListener('click', closeUserModal);
    const closeViewUserModalBtn = document.getElementById('closeViewUserModalBtn');
    if (closeViewUserModalBtn) closeViewUserModalBtn.addEventListener('click', closeViewUserModal);
    const closeChangeRoleModalBtn = document.getElementById('closeChangeRoleModalBtn');
    const cancelChangeRoleModalBtn = document.getElementById('cancelChangeRoleModalBtn');
    if (closeChangeRoleModalBtn) closeChangeRoleModalBtn.addEventListener('click', closeChangeRoleModal);
    if (cancelChangeRoleModalBtn) cancelChangeRoleModalBtn.addEventListener('click', closeChangeRoleModal);
    const saveUserRoleBtn = document.getElementById('saveUserRoleBtn');
    if (saveUserRoleBtn) saveUserRoleBtn.addEventListener('click', saveUserRole);

    // History filter
    const historyFilterHeader = document.getElementById('historyFilterHeader');
    if (historyFilterHeader) historyFilterHeader.addEventListener('click', toggleHistoryFilters);
    const clearHistoryFiltersBtn = document.getElementById('clearHistoryFiltersBtn');
    if (clearHistoryFiltersBtn) clearHistoryFiltersBtn.addEventListener('click', clearHistoryFilters);
    const exportHistoryBtn = document.getElementById('exportHistoryBtn');
    if (exportHistoryBtn) exportHistoryBtn.addEventListener('click', exportHistory);

    // Add network/bundle
    const addNetworkBtn = document.getElementById('addNetworkBtn');
    if (addNetworkBtn) addNetworkBtn.addEventListener('click', openAddNetworkModal);
    const addBundleBtn = document.getElementById('addBundleBtn');
    if (addBundleBtn) addBundleBtn.addEventListener('click', openAddBundleModal);

    // Save all settings
    const saveAllSettingsBtn = document.getElementById('saveAllSettingsBtn');
    if (saveAllSettingsBtn) saveAllSettingsBtn.addEventListener('click', saveAllSettings);
});
