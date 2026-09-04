import { afterAll, describe, expect, it } from 'vitest'
import { del, E2E_ENABLED, get, mintDeviceToken, post, registerCleanup, runCleanups, tinyPly, uploadTo } from './helpers.js'

describe.skipIf(!E2E_ENABLED)('E2E: maps', () => {
  afterAll(runCleanups)

  it('create -> signed-URL PUT of a tiny PLY -> finalize -> get -> delete', async () => {
    const device = await mintDeviceToken('maps-owner')

    const created = await post('/v1/maps', { name: `E2E map ${Date.now()}`, files: ['cloud.ply'] }, device.token)
    expect(created.status).toBe(201)
    const mapId = created.body.map.id as string
    registerCleanup(async () => { await del(`/v1/maps/${mapId}`, device.token) })
    expect(created.body.map.status).toBe('uploading')

    const upload = created.body.uploads.find((u: { path: string }) => u.path.endsWith('cloud.ply'))
    expect(upload).toBeTruthy()
    expect(upload.resumable).toBe(true) // cloud.ply is always a resumable upload (src/routes/maps.ts LARGE set)

    await uploadTo(upload, tinyPly())

    const finalized = await post(`/v1/maps/${mapId}/finalize`, {}, device.token)
    expect(finalized.status).toBe(200)
    expect(finalized.body.map.status).toBe('saved')
    expect(finalized.body.map.files).toContain('cloud.ply')
    expect(finalized.body.map.finalizedAt).toBeTruthy()

    const fetched = await get(`/v1/maps/${mapId}`, device.token)
    expect(fetched.status).toBe(200)
    expect(fetched.body.map.id).toBe(mapId)
    expect(fetched.body.downloads['cloud.ply'].url).toMatch(/^https:\/\//)

    const deleted = await del(`/v1/maps/${mapId}`, device.token)
    expect(deleted.status).toBe(200)
    expect(deleted.body.deleted).toBe(true)

    const afterDelete = await get(`/v1/maps/${mapId}`, device.token)
    expect(afterDelete.status).toBe(404)
  })

  it('refuses to finalize before cloud.ply has been uploaded', async () => {
    const device = await mintDeviceToken('maps-incomplete')
    const created = await post('/v1/maps', { name: `E2E incomplete ${Date.now()}`, files: ['cloud.ply'] }, device.token)
    expect(created.status).toBe(201)
    const mapId = created.body.map.id as string
    registerCleanup(async () => { await del(`/v1/maps/${mapId}`, device.token) })

    const finalized = await post(`/v1/maps/${mapId}/finalize`, {}, device.token)
    expect(finalized.status).toBe(400)
    expect(finalized.body.error.code).toBe('bad_request')
  })

  it('refuses a device that does not own the map', async () => {
    const owner = await mintDeviceToken('maps-owner2')
    const stranger = await mintDeviceToken('maps-stranger')
    const created = await post('/v1/maps', { name: `E2E stranger ${Date.now()}`, files: ['cloud.ply'] }, owner.token)
    expect(created.status).toBe(201)
    const mapId = created.body.map.id as string
    registerCleanup(async () => { await del(`/v1/maps/${mapId}`, owner.token) })

    expect((await del(`/v1/maps/${mapId}`, stranger.token)).status).toBe(403)
    expect((await post(`/v1/maps/${mapId}/finalize`, {}, stranger.token)).status).toBe(403)
  })
})
