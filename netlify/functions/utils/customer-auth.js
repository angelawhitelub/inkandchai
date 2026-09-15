/**
 * Identify the signed-in customer from their Supabase session JWT.
 *
 * Extracted from the pattern get-my-orders.js established: validate the token
 * with the service-key client, then act on the user id it returns. Anything
 * that hands over paid goods needs exactly this and must not improvise -- an
 * endpoint that trusts an email or a user id from the request body is an
 * endpoint where typing someone else's address is enough to take their books.
 */

/**
 * @returns {{ user: object } | { error: string, status: number }}
 */
async function requireCustomer(event, supabase) {
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { error: 'Please sign in first.', status: 401 };
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return { error: 'Your session has expired — please sign in again.', status: 401 };
    return { user };
  } catch (e) {
    return { error: 'Could not verify your session.', status: 401 };
  }
}

module.exports = { requireCustomer };
