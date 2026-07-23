/**
 * Google Customer Reviews opt-in for confirmed Ink & Chai orders.
 * Required order data is supplied only after the checkout backend confirms it.
 */
(function () {
  'use strict';

  const MERCHANT_ID = 5782474419;
  const PLATFORM_SCRIPT_ID = 'google-customer-reviews-platform';
  const renderedOrders = new Set();
  let pendingOrder = null;

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
  }

  function estimatedDeliveryDate() {
    const date = new Date();
    date.setDate(date.getDate() + 3);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function renderPendingOrder() {
    if (!pendingOrder || !window.gapi || renderedOrders.has(pendingOrder.order_id)) return;

    const order = pendingOrder;
    renderedOrders.add(order.order_id);
    window.gapi.load('surveyoptin', function () {
      window.gapi.surveyoptin.render({
        merchant_id: MERCHANT_ID,
        order_id: order.order_id,
        email: order.email,
        delivery_country: 'IN',
        estimated_delivery_date: estimatedDeliveryDate(),
        opt_in_style: 'CENTER_DIALOG',
      });
    });
  }

  // Google invokes this named callback after platform.js has loaded.
  window.renderOptIn = renderPendingOrder;

  function render(order) {
    const orderId = String(order && order.orderId || '').trim();
    const email = String(order && order.email || '').trim();
    if (!orderId || !isValidEmail(email) || renderedOrders.has(orderId)) return false;

    pendingOrder = { order_id: orderId, email };
    if (window.gapi) {
      renderPendingOrder();
      return true;
    }

    if (!document.getElementById(PLATFORM_SCRIPT_ID)) {
      const script = document.createElement('script');
      script.id = PLATFORM_SCRIPT_ID;
      script.src = 'https://apis.google.com/js/platform.js?onload=renderOptIn';
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    return true;
  }

  window.IACGoogleCustomerReviews = { render };
})();
