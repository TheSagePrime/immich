import { LoginResponseDto, getConfig } from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

describe('simple mode', () => {
  let admin: LoginResponseDto;
  let user: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    user = await utils.userSetup(admin.accessToken, createUserDto.user1);
  });

  beforeEach(async () => {
    await utils.resetAdminConfig(admin.accessToken);
  });

  it('should be enabled by default', async () => {
    const { status, body } = await request(app)
      .get('/admin/config')
      .set('Authorization', `Bearer ${admin.accessToken}`);

    expect(status).toBe(200);
    expect(body.server.simpleMode).toBe(true);
  });

  it('should expose the setting to logged in users', async () => {
    const { status, body } = await request(app).get('/config').set('Authorization', `Bearer ${user.accessToken}`);

    expect(status).toBe(200);
    expect(body.server).toEqual(expect.objectContaining({ simpleMode: true }));
  });

  it('should not expose the setting publicly', async () => {
    const { status, body } = await request(app).get('/public/config');

    expect(status).toBe(200);
    expect(body.server).toEqual({ loginPageMessage: '' });
  });

  it('should be turned off and on again by an admin', async () => {
    const config = await getConfig({ headers: asBearerAuth(admin.accessToken) });

    const off = await request(app)
      .put('/admin/config')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ ...config, server: { ...config.server, simpleMode: false } });
    expect(off.status).toBe(200);
    expect(off.body.server.simpleMode).toBe(false);

    const userView = await request(app).get('/config').set('Authorization', `Bearer ${user.accessToken}`);
    expect(userView.body.server.simpleMode).toBe(false);

    const on = await request(app)
      .put('/admin/config')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ ...config, server: { ...config.server, simpleMode: true } });
    expect(on.status).toBe(200);
    expect(on.body.server.simpleMode).toBe(true);
  });

  it('should reject a value that is not a boolean', async () => {
    const config = await getConfig({ headers: asBearerAuth(admin.accessToken) });

    const { status } = await request(app)
      .put('/admin/config')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ ...config, server: { ...config.server, simpleMode: 'yes' } });

    expect(status).toBe(400);
  });

  it('should not let a regular user change the setting', async () => {
    const config = await getConfig({ headers: asBearerAuth(admin.accessToken) });

    const { status } = await request(app)
      .put('/admin/config')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ ...config, server: { ...config.server, simpleMode: false } });

    expect(status).toBe(403);
  });
});
