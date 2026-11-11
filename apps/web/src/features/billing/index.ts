/**
 * What other features may use of billing: the calls to its API and the dialogs that correct money
 * after a register closed (the cash register screen offers them next to its entries).
 */
export { billingApi, billingKeys } from './api/billing-api.js';
export { CorrectPaymentDialog } from './components/CorrectPaymentDialog.js';
export { ErrorAlert } from './components/ErrorAlert.js';
export { RefundDialog } from './components/RefundDialog.js';
