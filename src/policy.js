/**
 * Policy layer: a spending guard for agent wallets.
 *
 * An agent that can sign payments needs a budget. These rules are enforced in
 * code, outside the model, so a prompt injection cannot raise the limit.
 *
 *   - daily / per-request caps (in USD)
 *   - allow-list of payees (contract addresses)
 *   - block-list of contracts
 *   - per-provider caps
 */

export class SpendPolicy {
  /**
   * @param {object} [opts]
   * @param {number} [opts.dailyUsd] maximum spend per UTC day
   * @param {number} [opts.perRequestUsd] maximum spend for one payment
   * @param {string[]} [opts.allowPayees] contract addresses that may be paid
   * @param {string[]} [opts.blockContracts] contract addresses that may never be paid
   * @param {Record<string, number>} [opts.perProviderUsd] cap per network id
   * @param {number} [opts.maxPayments] maximum number of payments per day
   */
  constructor(opts = {}) {
    this.dailyUsd = opts.dailyUsd ?? 5
    this.perRequestUsd = opts.perRequestUsd ?? 1
    this.allowPayees = (opts.allowPayees ?? []).map((a) => a.toLowerCase())
    this.blockContracts = (opts.blockContracts ?? []).map((a) => a.toLowerCase())
    this.perProviderUsd = opts.perProviderUsd ?? {}
    this.maxPayments = opts.maxPayments ?? 100
    /** @type {{day: string, spentUsd: number, payments: number, byProvider: Record<string, number>}} */
    this.state = { day: "", spentUsd: 0, payments: 0, byProvider: {} }
  }

  static day(now = new Date()) {
    return now.toISOString().slice(0, 10)
  }

  _roll(now = new Date()) {
    const day = SpendPolicy.day(now)
    if (this.state.day !== day) {
      this.state = { day, spentUsd: 0, payments: 0, byProvider: {} }
    }
  }

  /**
   * Check a planned payment against the policy.
   * @param {{amount: number, payTo?: string, asset?: string, network?: string}} req
   * @returns {{allowed: boolean, reason?: string}}
   */
  check(req, now = new Date()) {
    this._roll(now)
    const amount = Number(req.amount || 0)
    if (!Number.isFinite(amount) || amount <= 0) return { allowed: false, reason: "invalid amount" }
    if (amount > this.perRequestUsd)
      return { allowed: false, reason: `per-request cap ${this.perRequestUsd} USDC exceeded` }
    if (this.state.spentUsd + amount > this.dailyUsd)
      return { allowed: false, reason: `daily cap ${this.dailyUsd} USDC exceeded` }
    if (this.state.payments + 1 > this.maxPayments)
      return { allowed: false, reason: `max ${this.maxPayments} payments per day reached` }
    if (req.payTo && this.allowPayees.length && !this.allowPayees.includes(req.payTo.toLowerCase()))
      return { allowed: false, reason: `payee ${req.payTo} is not on the allow-list` }
    if (req.asset && this.blockContracts.includes(req.asset.toLowerCase()))
      return { allowed: false, reason: `asset ${req.asset} is blocked` }
    const net = req.network || "unknown"
    const spent = this.state.byProvider[net] || 0
    const cap = this.perProviderUsd[net]
    if (cap != null && spent + amount > cap)
      return { allowed: false, reason: `provider cap ${cap} USDC exceeded for ${net}` }
    return { allowed: true }
  }

  _apply(req) {
    const amount = Number(req.amount || 0)
    const net = req.network || "unknown"
    this.state.spentUsd += amount
    this.state.payments += 1
    this.state.byProvider[net] = (this.state.byProvider[net] || 0) + amount
    return { amount, net, day: this.state.day }
  }

  /**
   * Hold the spend before a payment is submitted.
   * The returned function releases the hold if settlement does not succeed.
   * Concurrent calls see the hold, so two in-flight payments cannot both pass the cap.
   */
  reserve(req, now = new Date()) {
    const verdict = this.check(req, now)
    if (!verdict.allowed) {
      const error = new Error(verdict.reason || "policy blocked the payment")
      error.code = "policy"
      throw error
    }
    const held = this._apply(req)
    let released = false
    return () => {
      if (released) return
      released = true
      if (this.state.day !== held.day) return
      this.state.spentUsd -= held.amount
      this.state.payments -= 1
      this.state.byProvider[held.net] = (this.state.byProvider[held.net] || 0) - held.amount
    }
  }

  /** Record a completed payment. Refuses to record a payment the policy would block. */
  commit(req, now = new Date()) {
    const verdict = this.check(req, now)
    if (!verdict.allowed) {
      const error = new Error(verdict.reason || "policy blocked the payment")
      error.code = "policy"
      throw error
    }
    this._apply(req)
  }

  /** Current spend report. */
  report(now = new Date()) {
    this._roll(now)
    return {
      day: this.state.day,
      spentUsd: round(this.state.spentUsd),
      dailyUsd: this.dailyUsd,
      leftUsd: round(Math.max(0, this.dailyUsd - this.state.spentUsd)),
      payments: this.state.payments,
      maxPayments: this.maxPayments,
      byProvider: this.state.byProvider,
    }
  }

  /** Spend ledger only. Config is stored by serialize(). */
  toJSON() {
    return {
      day: this.state.day,
      spentUsd: this.state.spentUsd,
      payments: this.state.payments,
      byProvider: { ...this.state.byProvider },
    }
  }

  /**
   * Full policy file: limits plus the ledger.
   * toJSON() stays the ledger so a log of the policy object cannot be reloaded as a higher cap.
   */
  serialize() {
    return {
      dailyUsd: this.dailyUsd,
      perRequestUsd: this.perRequestUsd,
      maxPayments: this.maxPayments,
      allowPayees: [...this.allowPayees],
      blockContracts: [...this.blockContracts],
      perProviderUsd: { ...this.perProviderUsd },
      state: this.toJSON(),
    }
  }

  static restore(data) {
    if (!data || typeof data !== "object") return new SpendPolicy()
    const legacyLedger = data.spentUsd != null && data.dailyUsd == null && data.state == null
    if (legacyLedger) {
      const policy = new SpendPolicy()
      policy.load(data)
      return policy
    }
    const policy = new SpendPolicy({
      dailyUsd: data.dailyUsd,
      perRequestUsd: data.perRequestUsd,
      maxPayments: data.maxPayments,
      allowPayees: data.allowPayees,
      blockContracts: data.blockContracts,
      perProviderUsd: data.perProviderUsd,
    })
    if (data.state && typeof data.state === "object") policy.load(data.state)
    return policy
  }

  load(data) {
    if (!data || typeof data !== "object") return this
    const spent = Number(data.spentUsd)
    const payments = Number(data.payments)
    const byProvider =
      data.byProvider && typeof data.byProvider === "object" && !Array.isArray(data.byProvider)
        ? data.byProvider
        : {}
    this.state = {
      day: typeof data.day === "string" ? data.day : this.state.day,
      spentUsd: Number.isFinite(spent) ? spent : this.state.spentUsd,
      payments: Number.isFinite(payments) ? payments : this.state.payments,
      byProvider: { ...byProvider },
    }
    return this
  }
}

function round(n) {
  return Math.round(n * 1e6) / 1e6
}
