// Fake D1 + Worker route tests.
//
// Usage: node --test tests/ai-worker.test.mjs
//
// Covers: authentication/roles, personal credential isolation and CAS,
// idempotent retries, deletion tombstones, managed catalog publishing,
// version conflicts, shared-key download, key rotation errors and CORS.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker from '../cloudflare-worker/src/worker.js';
import {
    buildPersonalAad,
    decryptSecret,
    normalizeBinding
} from '../cloudflare-worker/src/credential-crypto.js';
import { hashPassword, verifyPassword } from '../cloudflare-worker/src/password.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const ADMIN_TOKEN = 'a'.repeat(43);
const ALICE_TOKEN = 'b'.repeat(43);
const BOB_TOKEN = 'c'.repeat(43);
const WEAK_TOKEN = 'short-pass';
const MASTER = Buffer.alloc(32, 7).toString('base64');

class FakeD1 {
    constructor() {
        this.users = new Map();
        this.snapshots = new Map();
        this.credentials = new Map();
        this.releases = [];
        this.audits = [];
        this.sessions = new Map();
        this.pairingCodes = new Map();
    }

    addUser({ token, userId, label = '', role = 'user', recovery = '', email = null, createdAt = null, username = '', passwordHash = null, authVersion = 1, isActive = 1 }) {
        this.users.set(sha256(token), {
            token_hash: sha256(token),
            user_id: userId,
            label,
            role,
            recovery_hash: recovery ? sha256(recovery) : null,
            email,
            created_at: createdAt,
            username: username || null,
            username_normalized: username ? username.toLowerCase() : null,
            password_hash: passwordHash,
            password_updated_at: passwordHash ? new Date().toISOString() : null,
            auth_version: authVersion,
            is_active: isActive
        });
    }

    addSession({ token, userId, createdAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 86400000).toISOString(), deviceLabel = null, authVersion = 1 }) {
        this.sessions.set(sha256(token), {
            token_hash: sha256(token),
            user_id: userId,
            created_at: createdAt,
            expires_at: expiresAt,
            device_label: deviceLabel,
            auth_version: authVersion
        });
    }

    addPairingCode({ code, userId, createdBy = 'admin', createdAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 600000).toISOString(), usedAt = null }) {
        const normalized = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
        this.pairingCodes.set(sha256(normalized), {
            code_hash: sha256(normalized),
            user_id: userId,
            created_by: createdBy,
            created_at: createdAt,
            expires_at: expiresAt,
            used_at: usedAt
        });
    }

    prepare(sql) {
        const db = this;
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        const statement = {
            sql: normalized,
            args: [],
            bind(...args) { this.args = args; return this; },
            first() { return db.execute(normalized, this.args, 'first'); },
            run() { return db.execute(normalized, this.args, 'run'); },
            all() { return db.execute(normalized, this.args, 'all'); }
        };
        return statement;
    }

    async batch(statements) {
        const usersBackup = new Map([...this.users].map(([key, user]) => [key, { ...user }]));
        const auditsBackup = this.audits.slice();
        const sessionsBackup = new Map([...this.sessions].map(([key, session]) => [key, { ...session }]));
        const pairingBackup = new Map([...this.pairingCodes].map(([key, code]) => [key, { ...code }]));
        const results = [];
        try {
            for (const statement of statements) results.push(await statement.run());
            return results;
        } catch (error) {
            this.users = usersBackup;
            this.audits = auditsBackup;
            this.sessions = sessionsBackup;
            this.pairingCodes = pairingBackup;
            throw error;
        }
    }

    credentialKey(userId, providerId) {
        return `${userId}\u0000${providerId}`;
    }

    async execute(sql, args, mode) {
        if (sql === 'SELECT user_id, label, role FROM users WHERE token_hash = ?') {
            const user = this.users.get(args[0]);
            return user ? { user_id: user.user_id, label: user.label, role: user.role } : null;
        }
        if (sql === 'SELECT user_id, label, role, username, password_hash, is_active FROM users WHERE token_hash = ?') {
            const user = this.users.get(args[0]);
            return user ? {
                user_id: user.user_id,
                label: user.label,
                role: user.role,
                username: user.username,
                password_hash: user.password_hash,
                is_active: user.is_active
            } : null;
        }
        if (sql === 'SELECT user_id, label, role, username, password_hash, auth_version, is_active FROM users WHERE username_normalized = ?') {
            for (const user of this.users.values()) {
                if (user.username_normalized !== args[0]) continue;
                return {
                    user_id: user.user_id,
                    label: user.label,
                    role: user.role,
                    username: user.username,
                    password_hash: user.password_hash,
                    auth_version: user.auth_version,
                    is_active: user.is_active
                };
            }
            return null;
        }
        if (sql === 'SELECT password_hash, auth_version, role FROM users WHERE user_id = ?') {
            for (const user of this.users.values()) {
                if (user.user_id !== args[0]) continue;
                return { password_hash: user.password_hash, auth_version: user.auth_version, role: user.role };
            }
            return null;
        }
        if (sql === 'SELECT recovery_hash FROM users WHERE user_id = ?') {
            for (const user of this.users.values()) if (user.user_id === args[0]) return { recovery_hash: user.recovery_hash };
            return null;
        }
        if (sql === 'SELECT u.user_id, u.label, u.role FROM user_sessions s JOIN users u ON u.user_id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?') {
            const session = this.sessions.get(args[0]);
            if (!session || !(session.expires_at > args[1])) return null;
            for (const user of this.users.values()) {
                if (user.user_id === session.user_id) {
                    return { user_id: user.user_id, label: user.label, role: user.role };
                }
            }
            return null;
        }
        if (sql === 'SELECT u.user_id, u.label, u.role, u.username, u.password_hash, u.is_active FROM user_sessions s JOIN users u ON u.user_id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND s.auth_version = u.auth_version') {
            const session = this.sessions.get(args[0]);
            if (!session || !(session.expires_at > args[1])) return null;
            for (const user of this.users.values()) {
                if (user.user_id !== session.user_id) continue;
                if ((Number(session.auth_version) || 1) !== (Number(user.auth_version) || 1)) return null;
                return {
                    user_id: user.user_id,
                    label: user.label,
                    role: user.role,
                    username: user.username,
                    password_hash: user.password_hash,
                    is_active: user.is_active
                };
            }
            return null;
        }
        if (sql === 'SELECT user_id, expires_at, used_at FROM pairing_codes WHERE code_hash = ?') {
            const row = this.pairingCodes.get(args[0]);
            return row ? { user_id: row.user_id, expires_at: row.expires_at, used_at: row.used_at } : null;
        }
        if (sql === 'INSERT INTO pairing_codes (code_hash, user_id, created_by, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?)') {
            const [codeHash, userId, createdBy, createdAt, expiresAt, usedAt] = args;
            if (this.pairingCodes.has(codeHash)) throw new Error('UNIQUE constraint failed: pairing_codes.code_hash');
            this.pairingCodes.set(codeHash, {
                code_hash: codeHash,
                user_id: userId,
                created_by: createdBy,
                created_at: createdAt,
                expires_at: expiresAt,
                used_at: usedAt
            });
            return { meta: { changes: 1 } };
        }
        if (sql === 'UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL') {
            const row = this.pairingCodes.get(args[1]);
            if (!row || row.used_at) return { meta: { changes: 0 } };
            row.used_at = args[0];
            return { meta: { changes: 1 } };
        }
        if (sql === 'DELETE FROM pairing_codes WHERE user_id = ? AND used_at IS NULL') {
            let changes = 0;
            for (const [key, row] of [...this.pairingCodes.entries()]) {
                if (row.user_id !== args[0] || row.used_at) continue;
                this.pairingCodes.delete(key);
                changes += 1;
            }
            return { meta: { changes } };
        }
        if (sql === 'INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at, device_label) VALUES (?, ?, ?, ?, ?)') {
            const [tokenHash, userId, createdAt, expiresAt, deviceLabel] = args;
            if (this.sessions.has(tokenHash)) throw new Error('UNIQUE constraint failed: user_sessions.token_hash');
            this.sessions.set(tokenHash, {
                token_hash: tokenHash,
                user_id: userId,
                created_at: createdAt,
                expires_at: expiresAt,
                device_label: deviceLabel,
                auth_version: 1
            });
            return { meta: { changes: 1 } };
        }
        if (sql === 'INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at, device_label, auth_version) VALUES (?, ?, ?, ?, ?, ?)') {
            const [tokenHash, userId, createdAt, expiresAt, deviceLabel, authVersion] = args;
            if (this.sessions.has(tokenHash)) throw new Error('UNIQUE constraint failed: user_sessions.token_hash');
            this.sessions.set(tokenHash, {
                token_hash: tokenHash,
                user_id: userId,
                created_at: createdAt,
                expires_at: expiresAt,
                device_label: deviceLabel,
                auth_version: authVersion
            });
            return { meta: { changes: 1 } };
        }
        if (sql === 'DELETE FROM user_sessions WHERE user_id = ?') {
            let changes = 0;
            for (const [key, session] of [...this.sessions.entries()]) {
                if (session.user_id !== args[0]) continue;
                this.sessions.delete(key);
                changes += 1;
            }
            return { meta: { changes } };
        }
        if (sql === 'DELETE FROM user_sessions WHERE user_id = ? AND token_hash <> ?') {
            let changes = 0;
            for (const [key, session] of [...this.sessions.entries()]) {
                if (session.user_id !== args[0] || key === args[1]) continue;
                this.sessions.delete(key);
                changes += 1;
            }
            return { meta: { changes } };
        }
        if (sql === 'UPDATE user_sessions SET auth_version = ? WHERE token_hash = ? AND user_id = ?') {
            const session = this.sessions.get(args[1]);
            if (!session || session.user_id !== args[2]) return { meta: { changes: 0 } };
            session.auth_version = args[0];
            return { meta: { changes: 1 } };
        }
        if (sql === 'UPDATE users SET token_hash = ? WHERE user_id = ?') {
            for (const user of this.users.values()) {
                if (user.user_id === args[1]) {
                    this.users.delete(user.token_hash);
                    user.token_hash = args[0];
                    this.users.set(user.token_hash, user);
                    return { meta: { changes: 1 } };
                }
            }
            return { meta: { changes: 0 } };
        }
        if (sql === 'UPDATE users SET token_hash = ?, auth_version = auth_version + 1 WHERE user_id = ?') {
            for (const [key, user] of [...this.users.entries()]) {
                if (user.user_id !== args[1]) continue;
                this.users.delete(key);
                user.token_hash = args[0];
                user.auth_version = (Number(user.auth_version) || 1) + 1;
                this.users.set(user.token_hash, user);
                return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
        }
        if (sql === 'UPDATE users SET password_hash = ?, password_updated_at = ?, auth_version = ? WHERE user_id = ?') {
            for (const user of this.users.values()) {
                if (user.user_id !== args[3]) continue;
                user.password_hash = args[0];
                user.password_updated_at = args[1];
                user.auth_version = args[2];
                return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
        }
        if (sql === 'UPDATE users SET label = ?, email = ?, username = ?, username_normalized = ?, password_hash = ?, password_updated_at = ?, auth_version = ? WHERE user_id = ?') {
            const [label, email, username, usernameNormalized, passwordHash, passwordUpdatedAt, authVersion, userId] = args;
            for (const user of this.users.values()) {
                if (user.user_id !== userId) continue;
                if (usernameNormalized) {
                    for (const other of this.users.values()) {
                        if (other !== user && other.username_normalized === usernameNormalized) {
                            throw new Error('UNIQUE constraint failed: users.username_normalized');
                        }
                    }
                }
                if (email) {
                    for (const other of this.users.values()) {
                        if (other !== user && other.email === email) throw new Error('UNIQUE constraint failed: users.email');
                    }
                }
                user.label = label;
                user.email = email;
                user.username = username;
                user.username_normalized = usernameNormalized;
                user.password_hash = passwordHash;
                user.password_updated_at = passwordUpdatedAt;
                user.auth_version = authVersion;
                return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
        }
        if (sql === 'SELECT user_id, label, role, email, created_at, username, password_hash FROM users ORDER BY (created_at IS NULL) ASC, created_at DESC, user_id ASC LIMIT ?') {
            const results = [...this.users.values()]
                .sort((a, b) => {
                    const aNull = a.created_at == null ? 1 : 0;
                    const bNull = b.created_at == null ? 1 : 0;
                    if (aNull !== bNull) return aNull - bNull;
                    if (a.created_at && b.created_at) {
                        const byTime = b.created_at.localeCompare(a.created_at);
                        if (byTime !== 0) return byTime;
                    }
                    return a.user_id.localeCompare(b.user_id);
                })
                .slice(0, args[0])
                .map((user) => ({
                    user_id: user.user_id,
                    label: user.label,
                    role: user.role,
                    email: user.email,
                    created_at: user.created_at,
                    username: user.username ?? null,
                    password_hash: user.password_hash ?? null
                }));
            return { results };
        }
        if (sql === 'SELECT user_id, label, role, auth_version, is_active FROM users WHERE user_id = ?') {
            for (const user of this.users.values()) {
                if (user.user_id !== args[0]) continue;
                return {
                    user_id: user.user_id,
                    label: user.label,
                    role: user.role,
                    auth_version: user.auth_version ?? 1,
                    is_active: user.is_active ?? 1
                };
            }
            return null;
        }
        if (sql === 'SELECT user_id, label, role, email, created_at, username, username_normalized, password_hash, password_updated_at, auth_version, is_active FROM users WHERE user_id = ?') {
            for (const user of this.users.values()) {
                if (user.user_id !== args[0]) continue;
                return {
                    user_id: user.user_id,
                    label: user.label,
                    role: user.role,
                    email: user.email,
                    created_at: user.created_at,
                    username: user.username ?? null,
                    username_normalized: user.username_normalized ?? null,
                    password_hash: user.password_hash ?? null,
                    password_updated_at: user.password_updated_at ?? null,
                    auth_version: user.auth_version ?? 1,
                    is_active: user.is_active ?? 1
                };
            }
            return null;
        }
        if (sql === 'SELECT user_id FROM users WHERE user_id = ?') {
            for (const user of this.users.values()) if (user.user_id === args[0]) return { user_id: user.user_id };
            return null;
        }
        if (sql === 'SELECT user_id FROM users WHERE email = ?') {
            for (const user of this.users.values()) if (user.email === args[0]) return { user_id: user.user_id };
            return null;
        }
        if (sql === 'SELECT user_id FROM users WHERE email = ? AND user_id <> ?') {
            for (const user of this.users.values()) {
                if (user.email === args[0] && user.user_id !== args[1]) return { user_id: user.user_id };
            }
            return null;
        }
        if (sql === 'SELECT user_id FROM users WHERE username_normalized = ?') {
            for (const user of this.users.values()) {
                if (user.username_normalized && user.username_normalized === args[0]) return { user_id: user.user_id };
            }
            return null;
        }
        if (sql === 'SELECT user_id FROM users WHERE username_normalized = ? AND user_id <> ?') {
            for (const user of this.users.values()) {
                if (user.username_normalized === args[0] && user.user_id !== args[1]) return { user_id: user.user_id };
            }
            return null;
        }
        if (sql === 'INSERT INTO users (token_hash, user_id, label, recovery_hash, role, email, created_at, username, username_normalized, password_hash, password_updated_at, auth_version, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)') {
            const [tokenHash, userId, label, recoveryHash, role, email, createdAt, username, usernameNormalized, passwordHash, passwordUpdatedAt] = args;
            for (const user of this.users.values()) {
                if (user.user_id === userId) throw new Error('UNIQUE constraint failed: users.user_id');
                if (email && user.email === email) throw new Error('UNIQUE constraint failed: users.email');
                if (usernameNormalized && user.username_normalized === usernameNormalized) {
                    throw new Error('UNIQUE constraint failed: users.username_normalized');
                }
            }
            if (this.users.has(tokenHash)) throw new Error('UNIQUE constraint failed: users.token_hash');
            this.users.set(tokenHash, {
                token_hash: tokenHash,
                user_id: userId,
                label,
                role,
                recovery_hash: recoveryHash,
                email,
                created_at: createdAt,
                username: username ?? null,
                username_normalized: usernameNormalized ?? null,
                password_hash: passwordHash ?? null,
                password_updated_at: passwordUpdatedAt ?? null,
                auth_version: 1,
                is_active: 1
            });
            return { meta: { changes: 1 } };
        }
        if (sql === 'UPDATE users SET label = ?, email = ? WHERE user_id = ?') {
            const [label, email, userId] = args;
            for (const user of this.users.values()) {
                if (user.user_id !== userId) continue;
                if (email) {
                    for (const other of this.users.values()) {
                        if (other !== user && other.email === email) throw new Error('UNIQUE constraint failed: users.email');
                    }
                }
                user.label = label;
                user.email = email;
                return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
        }
        if (sql === 'UPDATE users SET token_hash = ?, recovery_hash = ?, auth_version = auth_version + 1 WHERE user_id = ?') {
            const [tokenHash, recoveryHash, userId] = args;
            for (const [key, user] of [...this.users.entries()]) {
                if (user.user_id !== userId) continue;
                if (this.users.has(tokenHash) && tokenHash !== key) throw new Error('UNIQUE constraint failed: users.token_hash');
                this.users.delete(key);
                user.token_hash = tokenHash;
                user.recovery_hash = recoveryHash;
                user.auth_version = (Number(user.auth_version) || 1) + 1;
                this.users.set(tokenHash, user);
                return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
        }
        if (sql === 'INSERT INTO admin_audit_log (actor_user_id, action, target_user_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?)') {
            const [actorUserId, action, targetUserId, detailJson, createdAt] = args;
            this.audits.push({
                id: this.audits.length + 1,
                actor_user_id: actorUserId,
                action,
                target_user_id: targetUserId,
                detail_json: detailJson,
                created_at: createdAt
            });
            return { meta: { changes: 1 } };
        }

        if (sql === 'SELECT version FROM snapshots WHERE user_id = ?') {
            const row = this.snapshots.get(args[0]);
            return row ? { version: row.version } : null;
        }
        if (sql === 'SELECT version, updated_at, payload FROM snapshots WHERE user_id = ?') {
            return this.snapshots.get(args[0]) || null;
        }
        if (sql === 'INSERT INTO snapshots (user_id, version, updated_at, payload) VALUES (?, ?, ?, ?)') {
            if (this.snapshots.has(args[0])) throw new Error('unique');
            this.snapshots.set(args[0], { version: args[1], updated_at: args[2], payload: args[3] });
            return { meta: { changes: 1 } };
        }
        if (sql === 'UPDATE snapshots SET version = ?, updated_at = ?, payload = ? WHERE user_id = ? AND version = ?') {
            const row = this.snapshots.get(args[3]);
            if (!row || row.version !== args[4]) return { meta: { changes: 0 } };
            Object.assign(row, { version: args[0], updated_at: args[1], payload: args[2] });
            return { meta: { changes: 1 } };
        }

        if (sql === 'SELECT provider_id, binding_json, version, deleted, updated_at, last_mutation_id FROM user_ai_credentials WHERE user_id = ? ORDER BY provider_id') {
            const results = [];
            for (const row of this.credentials.values()) if (row.user_id === args[0]) results.push({ ...row });
            results.sort((a, b) => a.provider_id.localeCompare(b.provider_id));
            return { results };
        }
        if (sql === 'SELECT user_id, provider_id, binding_json, key_ciphertext, nonce, key_version, version, deleted, last_mutation_id, updated_at FROM user_ai_credentials WHERE user_id = ? AND provider_id = ?') {
            return this.credentials.get(this.credentialKey(args[0], args[1])) || null;
        }
        if (sql === 'SELECT COUNT(*) AS n FROM user_ai_credentials WHERE user_id = ?') {
            let n = 0;
            for (const row of this.credentials.values()) if (row.user_id === args[0]) n += 1;
            return { n };
        }
        if (sql.startsWith('INSERT INTO user_ai_credentials')) {
            const [userId, providerId, bindingJson, ciphertext, nonce, keyVersion, version, mutationId, updatedAt] = args;
            const key = this.credentialKey(userId, providerId);
            if (this.credentials.has(key)) throw new Error('unique');
            this.credentials.set(key, {
                user_id: userId,
                provider_id: providerId,
                binding_json: bindingJson,
                key_ciphertext: ciphertext,
                nonce,
                key_version: keyVersion,
                version,
                deleted: 0,
                last_mutation_id: mutationId,
                updated_at: updatedAt
            });
            return { meta: { changes: 1 } };
        }
        if (sql.startsWith('UPDATE user_ai_credentials SET binding_json =')) {
            const [bindingJson, ciphertext, nonce, keyVersion, version, mutationId, updatedAt, userId, providerId, expected] = args;
            const row = this.credentials.get(this.credentialKey(userId, providerId));
            if (!row || row.version !== expected) return { meta: { changes: 0 } };
            Object.assign(row, {
                binding_json: bindingJson,
                key_ciphertext: ciphertext,
                nonce,
                key_version: keyVersion,
                version,
                deleted: 0,
                last_mutation_id: mutationId,
                updated_at: updatedAt
            });
            return { meta: { changes: 1 } };
        }
        if (sql.startsWith('UPDATE user_ai_credentials SET key_ciphertext = NULL')) {
            const [version, mutationId, updatedAt, userId, providerId, expected] = args;
            const row = this.credentials.get(this.credentialKey(userId, providerId));
            if (!row || row.version !== expected) return { meta: { changes: 0 } };
            Object.assign(row, {
                key_ciphertext: null,
                nonce: null,
                key_version: null,
                version,
                deleted: 1,
                last_mutation_id: mutationId,
                updated_at: updatedAt
            });
            return { meta: { changes: 1 } };
        }

        if (sql === 'SELECT version, config_json, credentials_json, mutation_id, request_digest, published_by, published_at FROM ai_default_catalog_releases ORDER BY version DESC LIMIT 1') {
            return this.releases.length ? { ...this.releases[this.releases.length - 1] } : null;
        }
        if (sql === 'SELECT version, config_json, credentials_json, mutation_id, request_digest, published_by, published_at FROM ai_default_catalog_releases WHERE version = ?') {
            const row = this.releases.find((item) => item.version === args[0]);
            return row ? { ...row } : null;
        }
        if (sql === 'SELECT version, config_json, credentials_json, mutation_id, request_digest, published_by, published_at FROM ai_default_catalog_releases WHERE mutation_id = ?') {
            const row = this.releases.find((item) => item.mutation_id === args[0]);
            return row ? { ...row } : null;
        }
        if (sql.startsWith('INSERT INTO ai_default_catalog_releases')) {
            const [version, configJson, credentialsJson, mutationId, digest, publishedBy, publishedAt] = args;
            if (this.releases.some((item) => item.version === version || item.mutation_id === mutationId)) {
                return { meta: { changes: 0 } };
            }
            this.releases.push({
                version,
                config_json: configJson,
                credentials_json: credentialsJson,
                mutation_id: mutationId,
                request_digest: digest,
                published_by: publishedBy,
                published_at: publishedAt
            });
            return { meta: { changes: 1 } };
        }
        if (sql === 'SELECT version, config_json, published_by, published_at FROM ai_default_catalog_releases ORDER BY version DESC LIMIT ?') {
            const results = [...this.releases]
                .sort((a, b) => b.version - a.version)
                .slice(0, args[0])
                .map((item) => ({
                    version: item.version,
                    config_json: item.config_json,
                    published_by: item.published_by,
                    published_at: item.published_at
                }));
            return { results };
        }
        if (sql.startsWith('DELETE FROM ai_default_catalog_releases WHERE version NOT IN')) {
            const keep = [...this.releases].sort((a, b) => b.version - a.version).slice(0, args[0]);
            const keepSet = new Set(keep.map((item) => item.version));
            const before = this.releases.length;
            this.releases = this.releases.filter((item) => keepSet.has(item.version));
            return { meta: { changes: before - this.releases.length } };
        }

        throw new Error(`FakeD1: unsupported SQL: ${sql}`);
    }
}

function makeEnv(db, { withKeys = true, withPasswordPepper = true } = {}) {
    return {
        DB: db,
        ALLOWED_ORIGINS: 'https://app.example',
        AI_CREDENTIAL_KEY_VERSION: '1',
        ...(withPasswordPepper ? { PASSWORD_PEPPER: 'test-password-pepper-0123456789abcdef' } : {}),
        ...(withKeys ? {
            AI_CREDENTIAL_KEY_V1: MASTER,
            AI_CATALOG_DIGEST_KEY: 'digest-secret-for-tests-0123456789'
        } : {})
    };
}

function req(path, { method = 'GET', token = '', body, origin = 'https://app.example', clientIp = '' } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (origin) headers.Origin = origin;
    if (clientIp) headers['CF-Connecting-IP'] = clientIp;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return new Request(`https://sync.example${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
}

const BINDING = {
    formatVersion: 1,
    format: 'openai-chat',
    apiUrl: 'https://provider.example/v1/chat/completions',
    modelsUrl: 'https://provider.example/v1/models',
    authMode: 'bearer'
};

function catalogConfig({ enabled = true, keyRequired = true, model = 'm1' } = {}) {
    return {
        schemaVersion: 1,
        providers: [{
            id: 'managed-test',
            name: 'Test Managed',
            enabled,
            order: 0,
            format: 'openai-chat',
            apiUrl: 'https://managed.example/v1/chat/completions',
            modelsUrl: 'https://managed.example/v1/models',
            authMode: keyRequired ? 'bearer' : 'none',
            models: Array.from(new Set([model, 'm1', 'm2'])).map((id) => ({ id }))
        }],
        tasks: { assistant: { providerId: 'managed-test', model } }
    };
}

async function publish(env, body) {
    const response = await worker.fetch(req('/admin/ai-catalog/publish', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body
    }), env);
    return { status: response.status, data: await response.json().catch(() => ({})) };
}

test('authentication, roles and passcode strength', async () => {
    const db = new FakeD1();
    db.addUser({ token: ADMIN_TOKEN, userId: 'admin', label: 'Admin', role: 'admin' });
    db.addUser({ token: ALICE_TOKEN, userId: 'alice', label: 'Alice' });
    db.addUser({ token: WEAK_TOKEN, userId: 'weak', label: 'Weak' });
    const env = makeEnv(db);

    const me = await worker.fetch(req('/me', { token: ADMIN_TOKEN }), env);
    assert.equal(me.status, 200);
    assert.equal((await me.json()).role, 'admin');

    const alice = await worker.fetch(req('/me', { token: ALICE_TOKEN }), env);
    assert.equal((await alice.json()).role, 'user');

    const anon = await worker.fetch(req('/ai-catalog', { token: '' }), env);
    assert.equal(anon.status, 401);

    const weak = await worker.fetch(req('/ai-credentials', { token: WEAK_TOKEN }), env);
    assert.equal(weak.status, 403);
    assert.equal((await weak.json()).code, 'passcode_upgrade_required');

    // Snapshot access still works for an old (short) passcode.
    const weakSnapshot = await worker.fetch(req('/snapshot', { token: WEAK_TOKEN }), env);
    assert.equal(weakSnapshot.status, 200);
});

test('admin user management: list, create, edit and reset', async () => {
    const db = new FakeD1();
    db.addUser({ token: ADMIN_TOKEN, userId: 'admin', label: 'Admin', role: 'admin' });
    db.addUser({ token: ALICE_TOKEN, userId: 'alice', label: 'Alice' });
    const env = makeEnv(db);

    const denied = await worker.fetch(req('/admin/users', { token: ALICE_TOKEN }), env);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'admin_required');

    const list = await worker.fetch(req('/admin/users', { token: ADMIN_TOKEN }), env);
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(listBody.users.length, 2);
    assert.equal(listBody.currentUserId, 'admin');
    assert.ok(!JSON.stringify(listBody).includes('token_hash'));
    assert.ok(!JSON.stringify(listBody).includes('recovery_hash'));

    const created = await worker.fetch(req('/admin/users', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { userId: 'carol', label: 'Carol', email: 'Carol@Example.com' }
    }), env);
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.user.userId, 'carol');
    assert.equal(createdBody.user.role, 'user');
    assert.equal(createdBody.user.email, 'carol@example.com');
    assert.equal(createdBody.passcode.length, 43);
    assert.equal(createdBody.recoveryCode.length, 32);

    const storedCarol = [...db.users.values()].find((user) => user.user_id === 'carol');
    assert.ok(storedCarol);
    assert.ok(!JSON.stringify(storedCarol).includes(createdBody.passcode));
    assert.equal(storedCarol.token_hash, sha256(createdBody.passcode));
    assert.equal(storedCarol.recovery_hash, sha256(createdBody.recoveryCode));

    const duplicate = await worker.fetch(req('/admin/users', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { userId: 'carol', label: 'Another' }
    }), env);
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).code, 'user_exists');

    const duplicateEmail = await worker.fetch(req('/admin/users', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { userId: 'dave', email: 'carol@example.com' }
    }), env);
    assert.equal(duplicateEmail.status, 409);
    assert.equal((await duplicateEmail.json()).code, 'email_exists');

    const invalidId = await worker.fetch(req('/admin/users', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { userId: 'bad id' }
    }), env);
    assert.equal(invalidId.status, 400);
    assert.equal((await invalidId.json()).code, 'invalid_user_id');

    const edited = await worker.fetch(req('/admin/users/carol', {
        method: 'PUT',
        token: ADMIN_TOKEN,
        body: { label: 'Carol 2', email: 'carol2@example.com' }
    }), env);
    assert.equal(edited.status, 200);
    const editedBody = await edited.json();
    assert.equal(editedBody.user.label, 'Carol 2');
    assert.equal(editedBody.user.email, 'carol2@example.com');

    const meBefore = await worker.fetch(req('/me', { token: createdBody.passcode }), env);
    assert.equal(meBefore.status, 200);
    assert.equal((await meBefore.json()).user_id, 'carol');

    const reset = await worker.fetch(req('/admin/users/carol/reset-passcode', {
        method: 'POST',
        token: ADMIN_TOKEN
    }), env);
    assert.equal(reset.status, 200);
    const resetBody = await reset.json();
    assert.notEqual(resetBody.passcode, createdBody.passcode);
    assert.equal(resetBody.passcode.length, 43);
    assert.equal(resetBody.recoveryCode.length, 32);

    const oldMe = await worker.fetch(req('/me', { token: createdBody.passcode }), env);
    assert.equal(oldMe.status, 401);
    const newMe = await worker.fetch(req('/me', { token: resetBody.passcode }), env);
    assert.equal(newMe.status, 200);
    assert.equal((await newMe.json()).user_id, 'carol');

    assert.deepEqual(db.audits.map((item) => item.action), ['user_create', 'user_update', 'user_reset_passcode']);
    assert.equal(JSON.stringify(db.audits).includes(createdBody.passcode), false);
    assert.equal(JSON.stringify(db.audits).includes(resetBody.passcode), false);
});

test('admin user management: admin, unknown-user and weak-passcode guards', async () => {
    const db = new FakeD1();
    db.addUser({ token: ADMIN_TOKEN, userId: 'admin', role: 'admin' });
    db.addUser({ token: ALICE_TOKEN, userId: 'alice' });
    db.addUser({ token: 'd'.repeat(43), userId: 'other-admin', role: 'admin' });
    const env = makeEnv(db);

    const resetOtherAdmin = await worker.fetch(req('/admin/users/other-admin/reset-passcode', {
        method: 'POST', token: ADMIN_TOKEN
    }), env);
    assert.equal(resetOtherAdmin.status, 403);
    assert.equal((await resetOtherAdmin.json()).code, 'admin_account_protected');

    const resetSelf = await worker.fetch(req('/admin/users/admin/reset-passcode', {
        method: 'POST', token: ADMIN_TOKEN
    }), env);
    assert.equal(resetSelf.status, 403);
    assert.equal((await resetSelf.json()).code, 'admin_account_protected');

    const missingEdit = await worker.fetch(req('/admin/users/nobody', {
        method: 'PUT', token: ADMIN_TOKEN, body: { label: 'x' }
    }), env);
    assert.equal(missingEdit.status, 404);
    assert.equal((await missingEdit.json()).code, 'user_not_found');

    const missingReset = await worker.fetch(req('/admin/users/nobody/reset-passcode', {
        method: 'POST', token: ADMIN_TOKEN
    }), env);
    assert.equal(missingReset.status, 404);
    assert.equal((await missingReset.json()).code, 'user_not_found');

    const badMethod = await worker.fetch(req('/admin/users', {
        method: 'DELETE', token: ADMIN_TOKEN
    }), env);
    assert.equal(badMethod.status, 405);

    const badEmail = await worker.fetch(req('/admin/users', {
        method: 'POST', token: ADMIN_TOKEN, body: { userId: 'dave', email: 'not-an-email' }
    }), env);
    assert.equal(badEmail.status, 400);
    assert.equal((await badEmail.json()).code, 'invalid_email');

    db.addUser({ token: WEAK_TOKEN, userId: 'weak-admin', role: 'admin' });
    const weak = await worker.fetch(req('/admin/users', { token: WEAK_TOKEN }), env);
    assert.equal(weak.status, 403);
    assert.equal((await weak.json()).code, 'passcode_upgrade_required');
});

test('device pairing: one-time codes, session auth and revocation', async () => {
    const db = new FakeD1();
    db.addUser({ token: ADMIN_TOKEN, userId: 'admin', label: 'Admin', role: 'admin' });
    db.addUser({ token: ALICE_TOKEN, userId: 'alice', label: 'Alice' });
    const env = makeEnv(db);

    const denied = await worker.fetch(req('/admin/users/alice/pairing-code', {
        method: 'POST', token: ALICE_TOKEN
    }), env);
    assert.equal(denied.status, 403);

    const protectedAdmin = await worker.fetch(req('/admin/users/admin/pairing-code', {
        method: 'POST', token: ADMIN_TOKEN
    }), env);
    assert.equal(protectedAdmin.status, 403);
    assert.equal((await protectedAdmin.json()).code, 'admin_account_protected');

    const missing = await worker.fetch(req('/admin/users/nobody/pairing-code', {
        method: 'POST', token: ADMIN_TOKEN
    }), env);
    assert.equal(missing.status, 404);

    const issued = await worker.fetch(req('/admin/users/alice/pairing-code', {
        method: 'POST', token: ADMIN_TOKEN
    }), env);
    assert.equal(issued.status, 200);
    const issuedBody = await issued.json();
    assert.match(issuedBody.code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{16}$/);
    assert.equal(issuedBody.userId, 'alice');
    assert.equal(issuedBody.ttlSeconds, 604800);
    assert.ok(Date.parse(issuedBody.expiresAt) - Date.now() > 6.9 * 24 * 60 * 60 * 1000);
    // Only the hash is stored.
    assert.ok(db.pairingCodes.has(sha256(issuedBody.code)));
    assert.equal(JSON.stringify([...db.pairingCodes.values()]).includes(issuedBody.code), false);

    // Login accepts lowercase/separators and a case-insensitive user id, and
    // returns a 43-character session token.
    const formatted = issuedBody.code.toLowerCase().match(/.{1,4}/g).join('-');
    const paired = await worker.fetch(req('/pair', {
        method: 'POST', token: '', body: { userId: 'ALICE', code: formatted, deviceLabel: 'test' }
    }), env);
    assert.equal(paired.status, 200);
    const pairedBody = await paired.json();
    assert.equal(pairedBody.token.length, 43);
    assert.equal(pairedBody.user_id, 'alice');
    assert.equal(pairedBody.role, 'user');
    assert.ok(pairedBody.expires_at > new Date().toISOString());
    assert.equal(db.sessions.get(sha256(pairedBody.token)).user_id, 'alice');

    const sessionMe = await worker.fetch(req('/me', { token: pairedBody.token }), env);
    assert.equal(sessionMe.status, 200);
    assert.equal((await sessionMe.json()).user_id, 'alice');
    const sessionSnapshot = await worker.fetch(req('/snapshot', { token: pairedBody.token }), env);
    assert.equal(sessionSnapshot.status, 200);
    // Expired sessions are rejected even though the row still exists.
    const expiredToken = 'x'.repeat(43);
    db.addSession({ token: expiredToken, userId: 'alice', expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal((await worker.fetch(req('/me', { token: expiredToken }), env)).status, 401);
    // Pairing does not invalidate the original passcode.
    const originalMe = await worker.fetch(req('/me', { token: ALICE_TOKEN }), env);
    assert.equal(originalMe.status, 200);

    // Legacy 12-character codes still work, and userId is optional: the code
    // itself identifies the account.
    const legacyCode = 'ABCDEFGHJKLM';
    db.addPairingCode({ code: legacyCode, userId: 'alice' });
    const legacyPaired = await worker.fetch(req('/pair', {
        method: 'POST', token: '', body: { code: legacyCode }
    }), env);
    assert.equal(legacyPaired.status, 200);
    assert.equal((await legacyPaired.json()).user_id, 'alice');

    // A pairing code is single-use.
    const reused = await worker.fetch(req('/pair', {
        method: 'POST', token: '', body: { userId: 'alice', code: issuedBody.code }
    }), env);
    assert.equal(reused.status, 403);
    assert.equal((await reused.json()).code, 'pairing_invalid');

    const second = await worker.fetch(req('/admin/users/alice/pairing-code', {
        method: 'POST', token: ADMIN_TOKEN
    }), env);
    const secondBody = await second.json();
    const wrongAccount = await worker.fetch(req('/pair', {
        method: 'POST', token: '', body: { userId: 'admin', code: secondBody.code }
    }), env);
    assert.equal(wrongAccount.status, 403);
    assert.equal((await wrongAccount.json()).code, 'pairing_invalid');

    const third = await worker.fetch(req('/admin/users/alice/pairing-code', {
        method: 'POST', token: ADMIN_TOKEN
    }), env);
    const thirdBody = await third.json();
    db.pairingCodes.get(sha256(thirdBody.code)).expires_at = new Date(Date.now() - 1000).toISOString();
    const expired = await worker.fetch(req('/pair', {
        method: 'POST', token: '', body: { userId: 'alice', code: thirdBody.code }
    }), env);
    assert.equal(expired.status, 403);
    assert.equal((await expired.json()).code, 'pairing_invalid');

    // Resetting the passcode revokes paired sessions and unused pairing codes.
    const fourth = await worker.fetch(req('/admin/users/alice/pairing-code', {
        method: 'POST', token: ADMIN_TOKEN
    }), env);
    const fourthBody = await fourth.json();
    const reset = await worker.fetch(req('/admin/users/alice/reset-passcode', {
        method: 'POST', token: ADMIN_TOKEN
    }), env);
    assert.equal(reset.status, 200);
    const resetBody = await reset.json();
    const revokedSession = await worker.fetch(req('/me', { token: pairedBody.token }), env);
    assert.equal(revokedSession.status, 401);
    const revokedCode = await worker.fetch(req('/pair', {
        method: 'POST', token: '', body: { userId: 'alice', code: fourthBody.code }
    }), env);
    assert.equal(revokedCode.status, 403);
    const newPasscode = await worker.fetch(req('/me', { token: resetBody.passcode }), env);
    assert.equal(newPasscode.status, 200);

    assert.ok(db.audits.some((item) => item.action === 'user_pairing_code'));
    assert.equal(JSON.stringify(db.audits).includes(issuedBody.code), false);
    assert.equal(JSON.stringify(db.audits).includes(pairedBody.token), false);
});

test('login code TTL options, default and revocation', async () => {
    const db = new FakeD1();
    db.addUser({ token: ADMIN_TOKEN, userId: 'admin', role: 'admin' });
    db.addUser({ token: ALICE_TOKEN, userId: 'alice' });
    const env = makeEnv(db);

    const invalid = await worker.fetch(req('/admin/users/alice/pairing-code', {
        method: 'POST', token: ADMIN_TOKEN, body: { ttlSeconds: 3600 }
    }), env);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, 'invalid_ttl');

    const oneDay = await worker.fetch(req('/admin/users/alice/pairing-code', {
        method: 'POST', token: ADMIN_TOKEN, body: { ttlSeconds: 86400 }
    }), env);
    const oneDayBody = await oneDay.json();
    assert.equal(oneDayBody.ttlSeconds, 86400);
    const oneDayMs = Date.parse(oneDayBody.expiresAt) - Date.now();
    assert.ok(oneDayMs > 23.9 * 3600 * 1000 && oneDayMs <= 24 * 3600 * 1000 + 5000);

    const tenMinutes = await worker.fetch(req('/admin/users/alice/pairing-code', {
        method: 'POST', token: ADMIN_TOKEN, body: { ttlSeconds: 600 }
    }), env);
    assert.equal((await tenMinutes.json()).ttlSeconds, 600);

    const thirtyDays = await worker.fetch(req('/admin/users/alice/pairing-code', {
        method: 'POST', token: ADMIN_TOKEN, body: { ttlSeconds: 2592000 }
    }), env);
    assert.equal((await thirtyDays.json()).ttlSeconds, 2592000);

    // Empty body keeps the seven-day default.
    const defaulted = await worker.fetch(req('/admin/users/alice/pairing-code', {
        method: 'POST', token: ADMIN_TOKEN
    }), env);
    assert.equal((await defaulted.json()).ttlSeconds, 604800);

    const denied = await worker.fetch(req('/admin/users/alice/pairing-codes', {
        method: 'DELETE', token: ALICE_TOKEN
    }), env);
    assert.equal(denied.status, 403);

    const adminProtected = await worker.fetch(req('/admin/users/admin/pairing-codes', {
        method: 'DELETE', token: ADMIN_TOKEN
    }), env);
    assert.equal(adminProtected.status, 403);
    assert.equal((await adminProtected.json()).code, 'admin_account_protected');

    const revoke = await worker.fetch(req('/admin/users/alice/pairing-codes', {
        method: 'DELETE', token: ADMIN_TOKEN
    }), env);
    assert.equal(revoke.status, 200);
    const revokeBody = await revoke.json();
    assert.equal(revokeBody.userId, 'alice');
    assert.equal(revokeBody.revoked, 4);
    assert.equal([...db.pairingCodes.values()].filter((row) => row.user_id === 'alice' && !row.used_at).length, 0);
    assert.ok(db.audits.some((item) => item.action === 'user_pairing_codes_revoke'));

    const afterRevoke = await worker.fetch(req('/pair', {
        method: 'POST', token: '', body: { code: oneDayBody.code }
    }), env);
    assert.equal(afterRevoke.status, 403);
});

test('auth capabilities expose login-code and password support', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const res = await worker.fetch(req('/auth-capabilities'), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
        pairingLogin: true,
        loginLinks: true,
        passwordLogin: true,
        passwordMinLength: 10,
        adminPasswordMinLength: 12
    });

    const noPepper = await worker.fetch(req('/auth-capabilities'), makeEnv(db, { withPasswordPepper: false }));
    assert.equal(noPepper.status, 200);
    assert.deepEqual(await noPepper.json(), {
        pairingLogin: true,
        loginLinks: true,
        passwordLogin: false,
        passwordMinLength: 10,
        adminPasswordMinLength: 12
    });
});

test('password login issues a session and rejects bad credentials', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const passwordHash = await hashPassword('correct horse battery', env.PASSWORD_PEPPER);
    db.addUser({ token: ALICE_TOKEN, userId: 'alice', label: 'Alice', username: 'Alice.W', passwordHash });
    db.addUser({
        token: 'd'.repeat(43),
        userId: 'disabled',
        username: 'disabled-user',
        passwordHash: await hashPassword('another good password', env.PASSWORD_PEPPER),
        isActive: 0
    });

    const ok = await worker.fetch(req('/login', {
        method: 'POST',
        clientIp: '203.0.113.10',
        body: { username: '  ALICE.W ', password: 'correct horse battery', deviceLabel: 'Test device' }
    }), env);
    assert.equal(ok.status, 200);
    const session = await ok.json();
    assert.equal(session.user_id, 'alice');
    assert.equal(session.username, 'Alice.W');
    assert.equal(session.role, 'user');
    assert.equal(session.hasPassword, true);
    assert.equal(session.token.length, 43);
    assert.ok(db.sessions.has(sha256(session.token)));
    assert.equal(db.sessions.get(sha256(session.token)).device_label, 'Test device');

    const me = await worker.fetch(req('/me', { token: session.token }), env);
    assert.equal(me.status, 200);
    const meBody = await me.json();
    assert.equal(meBody.user_id, 'alice');
    assert.equal(meBody.username, 'Alice.W');
    assert.equal(meBody.hasPassword, true);

    const wrong = await worker.fetch(req('/login', {
        method: 'POST', clientIp: '203.0.113.10', body: { username: 'alice.w', password: 'wrong password!' }
    }), env);
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).code, 'invalid_credentials');

    const unknown = await worker.fetch(req('/login', {
        method: 'POST', clientIp: '203.0.113.10', body: { username: 'nobody', password: 'correct horse battery' }
    }), env);
    assert.equal(unknown.status, 401);
    assert.equal((await unknown.json()).code, 'invalid_credentials');

    const missing = await worker.fetch(req('/login', {
        method: 'POST', clientIp: '203.0.113.10', body: { username: 'alice.w' }
    }), env);
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).code, 'invalid_credentials');

    const disabled = await worker.fetch(req('/login', {
        method: 'POST', clientIp: '203.0.113.10', body: { username: 'disabled-user', password: 'another good password' }
    }), env);
    assert.equal(disabled.status, 403);
    assert.equal((await disabled.json()).code, 'account_disabled');

    const noPepper = await worker.fetch(req('/login', {
        method: 'POST', clientIp: '203.0.113.11', body: { username: 'alice.w', password: 'correct horse battery' }
    }), makeEnv(db, { withPasswordPepper: false }));
    assert.equal(noPepper.status, 503);
    assert.equal((await noPepper.json()).code, 'password_not_configured');
});

test('password login is rate limited per client and username', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const body = { username: 'rate-limited', password: 'wrong password!!' };
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const res = await worker.fetch(req('/login', { method: 'POST', clientIp: '198.51.100.7', body }), env);
        assert.equal(res.status, 401);
    }
    const blocked = await worker.fetch(req('/login', { method: 'POST', clientIp: '198.51.100.7', body }), env);
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).code, 'rate_limited');
    assert.ok(Number(blocked.headers.get('Retry-After')) > 0);

    const otherClient = await worker.fetch(req('/login', {
        method: 'POST', clientIp: '198.51.100.8', body
    }), env);
    assert.equal(otherClient.status, 401);
});

test('change password rotates auth_version and revokes other sessions', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const originalHash = await hashPassword('old password 123', env.PASSWORD_PEPPER);
    const otherToken = 'other-device-token'.padEnd(43, 'x');
    const currentToken = 'current-device-token'.padEnd(43, 'y');
    db.addUser({ token: ALICE_TOKEN, userId: 'alice', username: 'alice', passwordHash: originalHash, authVersion: 1 });
    db.addSession({ token: otherToken, userId: 'alice', authVersion: 1 });
    db.addSession({ token: currentToken, userId: 'alice', authVersion: 1 });
    db.addPairingCode({ code: 'UNUSEDCODE', userId: 'alice' });

    const weak = await worker.fetch(req('/change-password', {
        method: 'POST', token: currentToken, body: { currentPassword: 'old password 123', newPassword: 'short' }
    }), env);
    assert.equal(weak.status, 400);
    assert.equal((await weak.json()).code, 'weak_password');

    const wrongCurrent = await worker.fetch(req('/change-password', {
        method: 'POST', token: currentToken, body: { currentPassword: 'not the password', newPassword: 'new password 456' }
    }), env);
    assert.equal(wrongCurrent.status, 403);
    assert.equal((await wrongCurrent.json()).code, 'invalid_current_password');

    const changed = await worker.fetch(req('/change-password', {
        method: 'POST', token: currentToken, body: { currentPassword: 'old password 123', newPassword: 'new password 456' }
    }), env);
    assert.equal(changed.status, 200);
    assert.deepEqual(await changed.json(), { ok: true, authVersion: 2 });

    const stored = [...db.users.values()].find((user) => user.user_id === 'alice');
    assert.equal(stored.auth_version, 2);
    assert.notEqual(stored.password_hash, originalHash);
    assert.equal(await verifyPassword('new password 456', stored.password_hash, env.PASSWORD_PEPPER), true);
    assert.equal(db.pairingCodes.size, 0);

    const currentMe = await worker.fetch(req('/me', { token: currentToken }), env);
    assert.equal(currentMe.status, 200);
    const otherMe = await worker.fetch(req('/me', { token: otherToken }), env);
    assert.equal(otherMe.status, 401);

    const oldLogin = await worker.fetch(req('/login', {
        method: 'POST', clientIp: '203.0.113.20', body: { username: 'alice', password: 'old password 123' }
    }), env);
    assert.equal(oldLogin.status, 401);
    const newLogin = await worker.fetch(req('/login', {
        method: 'POST', clientIp: '203.0.113.20', body: { username: 'alice', password: 'new password 456' }
    }), env);
    assert.equal(newLogin.status, 200);
    assert.equal(db.sessions.get(sha256((await newLogin.json()).token)).auth_version, 2);
});

test('admin can assign credentials and password reset revokes sessions', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    db.addUser({ token: ADMIN_TOKEN, userId: 'admin', role: 'admin' });

    const created = await worker.fetch(req('/admin/users', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { userId: 'carol', label: 'Carol', username: 'Carol', password: 'carol-password' }
    }), env);
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.user.username, 'carol');
    assert.equal(createdBody.user.hasPassword, true);
    const stored = [...db.users.values()].find((user) => user.user_id === 'carol');
    assert.equal(stored.username_normalized, 'carol');
    assert.equal(await verifyPassword('carol-password', stored.password_hash, env.PASSWORD_PEPPER), true);

    const list = await worker.fetch(req('/admin/users', { token: ADMIN_TOKEN }), env);
    const listed = (await list.json()).users.find((user) => user.userId === 'carol');
    assert.equal(listed.username, 'carol');
    assert.equal(listed.hasPassword, true);

    const login = await worker.fetch(req('/login', {
        method: 'POST', clientIp: '203.0.113.30', body: { username: 'CAROL', password: 'carol-password' }
    }), env);
    assert.equal(login.status, 200);
    const sessionToken = (await login.json()).token;

    const duplicateUsername = await worker.fetch(req('/admin/users', {
        method: 'POST', token: ADMIN_TOKEN, body: { userId: 'dave', username: 'carol', password: 'dave-password' }
    }), env);
    assert.equal(duplicateUsername.status, 409);
    assert.equal((await duplicateUsername.json()).code, 'username_exists');

    const invalidUsername = await worker.fetch(req('/admin/users', {
        method: 'POST', token: ADMIN_TOKEN, body: { userId: 'erin', username: '-bad-', password: 'erin-password' }
    }), env);
    assert.equal(invalidUsername.status, 400);
    assert.equal((await invalidUsername.json()).code, 'invalid_username');

    const weakPassword = await worker.fetch(req('/admin/users', {
        method: 'POST', token: ADMIN_TOKEN, body: { userId: 'frank', username: 'frank', password: 'short' }
    }), env);
    assert.equal(weakPassword.status, 400);
    assert.equal((await weakPassword.json()).code, 'weak_password');

    const passwordWithoutUsername = await worker.fetch(req('/admin/users', {
        method: 'POST', token: ADMIN_TOKEN, body: { userId: 'grace', password: 'grace-password' }
    }), env);
    assert.equal(passwordWithoutUsername.status, 400);
    assert.equal((await passwordWithoutUsername.json()).code, 'username_required');

    const edited = await worker.fetch(req('/admin/users/carol', {
        method: 'PUT',
        token: ADMIN_TOKEN,
        body: { username: 'carol2', newPassword: 'carol-password-2' }
    }), env);
    assert.equal(edited.status, 200);
    const editedBody = await edited.json();
    assert.equal(editedBody.user.username, 'carol2');
    assert.equal(editedBody.user.hasPassword, true);

    const revoked = await worker.fetch(req('/me', { token: sessionToken }), env);
    assert.equal(revoked.status, 401);

    const oldLogin = await worker.fetch(req('/login', {
        method: 'POST', clientIp: '203.0.113.30', body: { username: 'carol', password: 'carol-password' }
    }), env);
    assert.equal(oldLogin.status, 401);
    const newLogin = await worker.fetch(req('/login', {
        method: 'POST', clientIp: '203.0.113.30', body: { username: 'carol2', password: 'carol-password-2' }
    }), env);
    assert.equal(newLogin.status, 200);

    const clearUsername = await worker.fetch(req('/admin/users/carol', {
        method: 'PUT', token: ADMIN_TOKEN, body: { username: '' }
    }), env);
    assert.equal(clearUsername.status, 400);
    assert.equal((await clearUsername.json()).code, 'username_required');

    const adminShortPassword = await worker.fetch(req('/admin/users/admin', {
        method: 'PUT', token: ADMIN_TOKEN, body: { username: 'admin', newPassword: '12345678901' }
    }), env);
    assert.equal(adminShortPassword.status, 400);
    assert.equal((await adminShortPassword.json()).code, 'weak_password');

    const adminCredentials = await worker.fetch(req('/admin/users/admin', {
        method: 'PUT', token: ADMIN_TOKEN, body: { username: 'admin', newPassword: '123456789012' }
    }), env);
    assert.equal(adminCredentials.status, 200);
    assert.equal((await adminCredentials.json()).user.hasPassword, true);

    const adminLogin = await worker.fetch(req('/login', {
        method: 'POST', clientIp: '203.0.113.30', body: { username: 'admin', password: '123456789012' }
    }), env);
    assert.equal(adminLogin.status, 200);
    assert.equal((await adminLogin.json()).role, 'admin');
});

test('passcode change and recovery reset revoke paired sessions', async () => {
    const db = new FakeD1();
    const recovery = 'r'.repeat(32);
    const changedPasscode = 'e'.repeat(43);
    const resetPasscode = 'f'.repeat(43);
    db.addUser({ token: ADMIN_TOKEN, userId: 'admin', role: 'admin' });
    db.addUser({ token: ALICE_TOKEN, userId: 'alice', recovery });
    const env = makeEnv(db);

    const issue = async () => {
        const res = await worker.fetch(req('/admin/users/alice/pairing-code', {
            method: 'POST', token: ADMIN_TOKEN
        }), env);
        return (await res.json()).code;
    };
    const pair = async (code) => {
        const res = await worker.fetch(req('/pair', {
            method: 'POST', token: '', body: { userId: 'alice', code }
        }), env);
        return (await res.json()).token;
    };

    const firstSession = await pair(await issue());
    const changed = await worker.fetch(req('/change-token', {
        method: 'POST', token: ALICE_TOKEN, body: { new_token: changedPasscode }
    }), env);
    assert.equal(changed.status, 200);
    assert.equal((await worker.fetch(req('/me', { token: firstSession }), env)).status, 401);
    assert.equal((await worker.fetch(req('/me', { token: ALICE_TOKEN }), env)).status, 401);
    assert.equal((await worker.fetch(req('/me', { token: changedPasscode }), env)).status, 200);

    const secondSession = await pair(await issue());
    const reset = await worker.fetch(req('/reset-token', {
        method: 'POST', token: '', body: {
            user_id: 'alice',
            recovery_code: recovery,
            new_token: resetPasscode
        }
    }), env);
    assert.equal(reset.status, 200);
    assert.equal((await worker.fetch(req('/me', { token: secondSession }), env)).status, 401);
    assert.equal((await worker.fetch(req('/me', { token: changedPasscode }), env)).status, 401);
    assert.equal((await worker.fetch(req('/me', { token: resetPasscode }), env)).status, 200);
});

test('personal credentials: isolation, CAS, idempotency and tombstones', async () => {
    const db = new FakeD1();
    db.addUser({ token: ALICE_TOKEN, userId: 'alice' });
    db.addUser({ token: BOB_TOKEN, userId: 'bob' });
    const env = makeEnv(db);

    const putAlice = await worker.fetch(req('/ai-credentials/personal-a', {
        method: 'PUT', token: ALICE_TOKEN,
        body: { expectedVersion: 0, mutationId: 'mutation-alice-0001', binding: BINDING, apiKey: 'alice-key' }
    }), env);
    assert.equal(putAlice.status, 200);
    await putAlice.json();

    // Literal ciphertext must never contain the plaintext key.
    const stored = [...db.credentials.values()][0];
    assert.ok(!stored.key_ciphertext.includes('alice-key'));

    // Same mutation id + same content is a replay (no version bump).
    const replay = await worker.fetch(req('/ai-credentials/personal-a', {
        method: 'PUT', token: ALICE_TOKEN,
        body: { expectedVersion: 0, mutationId: 'mutation-alice-0001', binding: BINDING, apiKey: 'alice-key' }
    }), env);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).version, 1);

    // Same mutation id, different content is rejected.
    const conflictSameMutation = await worker.fetch(req('/ai-credentials/personal-a', {
        method: 'PUT', token: ALICE_TOKEN,
        body: { expectedVersion: 0, mutationId: 'mutation-alice-0001', binding: BINDING, apiKey: 'other-key' }
    }), env);
    assert.equal(conflictSameMutation.status, 409);

    // A stale expected version is rejected with the current version.
    const stale = await worker.fetch(req('/ai-credentials/personal-a', {
        method: 'PUT', token: ALICE_TOKEN,
        body: { expectedVersion: 0, mutationId: 'mutation-alice-0002', binding: BINDING, apiKey: 'alice-key-2' }
    }), env);
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).version, 1);

    // Bob uses the same provider id but gets his own row.
    const putBob = await worker.fetch(req('/ai-credentials/personal-a', {
        method: 'PUT', token: BOB_TOKEN,
        body: { expectedVersion: 0, mutationId: 'mutation-bob-0001', binding: BINDING, apiKey: 'bob-key' }
    }), env);
    assert.equal(putBob.status, 200);

    const getBob = await worker.fetch(req('/ai-credentials/personal-a', { token: BOB_TOKEN }), env);
    assert.equal((await getBob.json()).apiKey, 'bob-key');
    const getAlice = await worker.fetch(req('/ai-credentials/personal-a', { token: ALICE_TOKEN }), env);
    assert.equal((await getAlice.json()).apiKey, 'alice-key');

    // Delete keeps a tombstone and clears the key.
    const del = await worker.fetch(req('/ai-credentials/personal-a', {
        method: 'DELETE', token: ALICE_TOKEN,
        body: { expectedVersion: 1, mutationId: 'mutation-alice-delete-1' }
    }), env);
    assert.equal(del.status, 200);
    assert.equal((await del.json()).version, 2);

    const delGet = await worker.fetch(req('/ai-credentials/personal-a', { token: ALICE_TOKEN }), env);
    const delBody = await delGet.json();
    assert.equal(delBody.deleted, true);
    assert.equal(delBody.apiKey, null);
    assert.equal(delBody.version, 2);

    // Recreating must be based on the tombstone version.
    const recreate = await worker.fetch(req('/ai-credentials/personal-a', {
        method: 'PUT', token: ALICE_TOKEN,
        body: { expectedVersion: 2, mutationId: 'mutation-alice-recreate', binding: BINDING, apiKey: 'alice-key-3' }
    }), env);
    assert.equal(recreate.status, 200);
    assert.equal((await recreate.json()).version, 3);
});

test('credential binding is part of the AAD', async () => {
    const db = new FakeD1();
    db.addUser({ token: ALICE_TOKEN, userId: 'alice' });
    const env = makeEnv(db);
    await worker.fetch(req('/ai-credentials/personal-a', {
        method: 'PUT', token: ALICE_TOKEN,
        body: { expectedVersion: 0, mutationId: 'mutation-aad-0001', binding: BINDING, apiKey: 'secret' }
    }), env);
    const row = db.credentials.get('alice\u0000personal-a');
    const other = normalizeBinding({ ...BINDING, apiUrl: 'https://evil.example/v1/chat/completions' });
    const aad = buildPersonalAad({
        userId: 'alice', providerId: 'personal-a', binding: other,
        version: Number(row.version), keyVersion: Number(row.key_version)
    });
    await assert.rejects(
        decryptSecret({ ciphertext: row.key_ciphertext, nonce: row.nonce, keyVersion: row.key_version }, { aad, keyVersion: row.key_version }, env),
        /credential/
    );
});

test('managed catalog: admin-only publish, shared key download and versions', async () => {
    const db = new FakeD1();
    db.addUser({ token: ADMIN_TOKEN, userId: 'admin', role: 'admin' });
    db.addUser({ token: ALICE_TOKEN, userId: 'alice' });
    const env = makeEnv(db);

    const unauthorizedRes = await worker.fetch(req('/admin/ai-catalog/publish', {
        method: 'POST',
        token: ALICE_TOKEN,
        body: {
            baseVersion: 0,
            mutationId: 'publish-denied-0001',
            config: catalogConfig(),
            keyOps: { 'managed-test': { action: 'replace', apiKey: 'shared-key' } }
        }
    }), env);
    assert.equal(unauthorizedRes.status, 403);

    const first = await publish(env, {
        baseVersion: 0,
        mutationId: 'publish-0001',
        config: catalogConfig(),
        keyOps: { 'managed-test': { action: 'replace', apiKey: 'shared-key' } }
    });
    assert.equal(first.status, 200);
    assert.equal(first.data.version, 1);

    // Public catalog is logged-in only and never contains the key.
    const anon = await worker.fetch(req('/ai-catalog', { token: '' }), env);
    assert.equal(anon.status, 401);
    const catalog = await worker.fetch(req('/ai-catalog', { token: ALICE_TOKEN }), env);
    assert.equal(catalog.status, 200);
    const catalogBody = await catalog.json();
    assert.equal(catalogBody.version, 1);
    assert.equal(catalogBody.providers[0].id, 'managed-test');
    assert.ok(!JSON.stringify(catalogBody).includes('shared-key'));

    const key = await worker.fetch(req('/ai-catalog/providers/managed-test/credential?catalogVersion=1', { token: ALICE_TOKEN }), env);
    assert.equal(key.status, 200);
    const keyBody = await key.json();
    assert.equal(keyBody.apiKey, 'shared-key');
    assert.equal(keyBody.binding.apiUrl, 'https://managed.example/v1/chat/completions');

    const wrongVersion = await worker.fetch(req('/ai-catalog/providers/managed-test/credential?catalogVersion=99', { token: ALICE_TOKEN }), env);
    assert.equal(wrongVersion.status, 409);

    // Publishing version 2 with a preserved key keeps the same credential revision.
    const second = await publish(env, {
        baseVersion: 1,
        mutationId: 'publish-0002',
        config: catalogConfig({ model: 'm2' }),
        keyOps: { 'managed-test': { action: 'preserve' } }
    });
    assert.equal(second.status, 200);
    assert.equal(second.data.version, 2);
    assert.equal(second.data.credentialRevisions['managed-test'], 1);

    // A stale base version conflicts and reports the current version.
    const stale = await publish(env, {
        baseVersion: 1,
        mutationId: 'publish-0003',
        config: catalogConfig(),
        keyOps: { 'managed-test': { action: 'preserve' } }
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.version, 2);

    // Same mutation + same content is idempotent.
    const replay = await publish(env, {
        baseVersion: 1,
        mutationId: 'publish-0002',
        config: catalogConfig({ model: 'm2' }),
        keyOps: { 'managed-test': { action: 'preserve' } }
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.data.idempotent, true);

    // Changing the endpoint while preserving the key is rejected.
    const changed = catalogConfig({ model: 'm2' });
    changed.providers[0].apiUrl = 'https://other.example/v1/chat/completions';
    const bindingChanged = await publish(env, {
        baseVersion: 2,
        mutationId: 'publish-0004',
        config: changed,
        keyOps: { 'managed-test': { action: 'preserve' } }
    });
    assert.equal(bindingChanged.status, 400);
    assert.equal(bindingChanged.data.code, 'binding_changed_requires_key');

    // Replacing the key increments the credential revision.
    const replaced = catalogConfig({ model: 'm2' });
    replaced.providers[0].apiUrl = 'https://other.example/v1/chat/completions';
    const rotated = await publish(env, {
        baseVersion: 2,
        mutationId: 'publish-0005',
        config: replaced,
        keyOps: { 'managed-test': { action: 'replace', apiKey: 'shared-key-2' } }
    });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.data.version, 3);
    assert.equal(rotated.data.credentialRevisions['managed-test'], 2);
    const newKey = await worker.fetch(req('/ai-catalog/providers/managed-test/credential?catalogVersion=3', { token: ALICE_TOKEN }), env);
    assert.equal((await newKey.json()).apiKey, 'shared-key-2');
});

test('disabled providers cannot be downloaded; clearing requires disabling', async () => {
    const db = new FakeD1();
    db.addUser({ token: ADMIN_TOKEN, userId: 'admin', role: 'admin' });
    db.addUser({ token: ALICE_TOKEN, userId: 'alice' });
    const env = makeEnv(db);
    await publish(env, {
        baseVersion: 0, mutationId: 'publish-disabled-0001',
        config: catalogConfig(), keyOps: { 'managed-test': { action: 'replace', apiKey: 'shared' } }
    });

    const clearEnabled = await publish(env, {
        baseVersion: 1, mutationId: 'publish-clear-enabled',
        config: catalogConfig(), keyOps: { 'managed-test': { action: 'clear' } }
    });
    assert.equal(clearEnabled.status, 400);
    assert.equal(clearEnabled.data.code, 'cannot_clear_enabled_provider_key');

    const disabled = await publish(env, {
        baseVersion: 1, mutationId: 'publish-disable-0001',
        config: catalogConfig({ enabled: false }), keyOps: { 'managed-test': { action: 'clear' } }
    });
    assert.equal(disabled.status, 200);
    const catalog = await worker.fetch(req('/ai-catalog', { token: ALICE_TOKEN }), env);
    const catalogBody = await catalog.json();
    assert.equal(catalogBody.version, 2);
    assert.equal(catalogBody.providers.length, 0);
    const key = await worker.fetch(req('/ai-catalog/providers/managed-test/credential?catalogVersion=2', { token: ALICE_TOKEN }), env);
    assert.equal(key.status, 404);
});

test('missing master key only breaks credential routes', async () => {
    const db = new FakeD1();
    db.addUser({ token: ALICE_TOKEN, userId: 'alice' });
    const env = makeEnv(db, { withKeys: false });
    const put = await worker.fetch(req('/ai-credentials/personal-a', {
        method: 'PUT', token: ALICE_TOKEN,
        body: { expectedVersion: 0, mutationId: 'mutation-nokey-0001', binding: BINDING, apiKey: 'secret' }
    }), env);
    assert.equal(put.status, 503);
    const snapshot = await worker.fetch(req('/snapshot', { token: ALICE_TOKEN }), env);
    assert.equal(snapshot.status, 200);
});

test('origin allow-list and no-store headers', async () => {
    const db = new FakeD1();
    db.addUser({ token: ALICE_TOKEN, userId: 'alice' });
    const env = makeEnv(db);
    const blocked = await worker.fetch(req('/me', { token: ALICE_TOKEN, origin: 'https://evil.example' }), env);
    assert.equal(blocked.status, 403);
    const allowed = await worker.fetch(req('/me', { token: ALICE_TOKEN }), env);
    assert.equal(allowed.status, 200);
    assert.match(allowed.headers.get('Cache-Control') || '', /no-store/);
    assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'https://app.example');
    const preflight = await worker.fetch(req('/me', { method: 'OPTIONS', origin: 'https://evil.example' }), env);
    assert.equal(preflight.status, 403);
});

test('server-side snapshot sanitisation drops keys and managed definitions', async () => {
    const db = new FakeD1();
    db.addUser({ token: ALICE_TOKEN, userId: 'alice' });
    const env = makeEnv(db);
    const malicious = {
        vocabulary: { updatedAt: '2026-01-01T00:00:00.000Z', books: [] },
        aiSettings: {
            updatedAt: '2026-01-01T00:00:00.000Z',
            settings: {
                providers: {
                    'personal-ok': {
                        label: 'Mine',
                        apiUrl: 'https://mine.example/v1/chat/completions',
                        modelsUrl: 'https://mine.example/v1/models',
                        apiKey: 'must-not-survive',
                        discoveryError: 'https://mine.example/v1/models?key=leak',
                        allowedModels: ['personal-ok:m1']
                    },
                    'managed-evil': { name: 'fake', apiUrl: 'https://evil.example', apiKey: 'shared' },
                    default: { apiUrl: 'https://legacy.example', apiKey: 'static' }
                },
                models: {
                    assistant: 'personal-ok:m1',
                    imageOCR: { provider: 'managed-real', model: 'm2', apiUrl: 'https://evil.example', apiKey: 'x' }
                },
                keySyncDefault: 'local-only',
                apiApiKey: 'top-level-leak'
            },
            apiKey: 'snapshot-level-leak'
        },
        aiApiKey: 'legacy-leak',
        aiProviders: { default: { apiKey: 'legacy-leak' } }
    };
    const post = await worker.fetch(req('/snapshot', {
        method: 'POST', token: ALICE_TOKEN, body: { expected_version: 0, payload: malicious }
    }), env);
    assert.equal(post.status, 200);
    const row = db.snapshots.get('alice');
    assert.equal(JSON.stringify(row.payload).includes('must-not-survive'), false);
    assert.equal(JSON.stringify(row.payload).includes('snapshot-level-leak'), false);
    assert.equal(JSON.stringify(row.payload).includes('legacy-leak'), false);
    assert.equal(JSON.stringify(row.payload).includes('managed-evil'), false);
    const read = await worker.fetch(req('/snapshot', { token: ALICE_TOKEN }), env);
    const body = await read.json();
    const settings = body.payload.aiSettings.settings;
    assert.deepEqual(Object.keys(settings.providers), ['personal-ok']);
    assert.equal(settings.providers['personal-ok'].apiKey, undefined);
    assert.equal(settings.providers['personal-ok'].discoveryError, undefined);
    assert.equal(settings.models.assistant, 'personal-ok:m1');
    assert.equal(settings.models.imageOCR, 'managed-real:m2');
    assert.equal(settings.keySyncDefault, 'local-only');
    assert.equal(JSON.stringify(body).includes('leak'), false);
});

test('snapshot CAS still works', async () => {
    const db = new FakeD1();
    db.addUser({ token: ALICE_TOKEN, userId: 'alice' });
    const env = makeEnv(db);
    const first = await worker.fetch(req('/snapshot', {
        method: 'POST', token: ALICE_TOKEN, body: { expected_version: 0, payload: { hello: 1 } }
    }), env);
    assert.equal(first.status, 200);
    const conflict = await worker.fetch(req('/snapshot', {
        method: 'POST', token: ALICE_TOKEN, body: { expected_version: 0, payload: { hello: 2 } }
    }), env);
    assert.equal(conflict.status, 409);
    const read = await worker.fetch(req('/snapshot', { token: ALICE_TOKEN }), env);
    assert.equal((await read.json()).version, 1);
});
