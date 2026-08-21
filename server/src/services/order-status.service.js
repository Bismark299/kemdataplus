/**
 * Returns the single customer-facing status for an order group.
 *
 * Order items are the fulfillment source of truth. A duplicate hold is the
 * exception: it is deliberately applied at the group level before any item
 * can be sent for fulfillment.
 */
function getCustomerOrderStatus(itemStatuses, groupStatus) {
  if (groupStatus === 'DUPLICATE_HOLD') {
    return 'DUPLICATE_HOLD';
  }

  if (!itemStatuses.length) {
    return groupStatus || 'PENDING';
  }

  if (itemStatuses.every(status => status === 'COMPLETED')) {
    return 'COMPLETED';
  }

  if (itemStatuses.every(status => status === 'FAILED')) {
    return 'FAILED';
  }

  if (itemStatuses.every(status => status === 'CANCELLED')) {
    return 'CANCELLED';
  }

  if (itemStatuses.some(status => status === 'PROCESSING' || status === 'COMPLETED')) {
    return 'PROCESSING';
  }

  return 'PENDING';
}

module.exports = { getCustomerOrderStatus };