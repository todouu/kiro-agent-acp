/**
 * This module is intentionally minimal.
 *
 * kiro-cli acp natively provides configOptions (model list, agent list, thinking levels)
 * in its session/new response. We do NOT hardcode these — we pass them through from kiro-cli.
 *
 * This file only exists for any future custom options we may want to add on top.
 */

/**
 * Additional config options that the proxy may inject on top of what kiro-cli provides.
 * Currently empty — kiro-cli handles everything.
 */
export const PROXY_EXTRA_CONFIG_OPTIONS: unknown[] = [];
