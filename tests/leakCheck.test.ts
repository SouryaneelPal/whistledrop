import { describe, expect, it } from 'vitest';
import { api } from './helpers';

async function warningTypes(description: string) {
  const res = await api.post('/api/reports/check').send({ description });
  expect(res.status).toBe(200);
  return res.body.warnings.map((w: { type: string }) => w.type);
}

describe('POST /api/reports/check', () => {
  it('returns no warnings for an ordinary report', async () => {
    const res = await api
      .post('/api/reports/check')
      .send({ description: 'The backup server has been open to the whole network since March 2024.' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ warnings: [] });
  });

  it('warns about an email address', async () => {
    for (const text of ['Contact me at someone.real@example.org', 'my mail is a_b+c@mail.co.in']) {
      expect(await warningTypes(text), text).toEqual(['EMAIL']);
    }
  });

  it('does not mistake an at sign or a plain domain for an email', async () => {
    for (const text of ['Meet @ 5pm near the gate', 'The vendor site is example.com']) {
      expect(await warningTypes(text), text).toEqual([]);
    }
  });

  it('warns about phone numbers in Indian and international formats', async () => {
    const numbers = [
      'Call 9876543210',
      'call +91 98765 43210',
      'call +91-9876543210',
      'call 09876543210',
      'call 98765-43210',
      'call 011-23456789',
      'call +44 20 7946 0958',
    ];
    for (const text of numbers) {
      expect(await warningTypes(text), text).toEqual(['PHONE']);
    }
  });

  it('does not mistake amounts, years or dates for phone numbers', async () => {
    for (const text of ['They took Rs 50,000 in 2023', 'Invoices from 12-03-2024 to 15-04-2024', 'About 1234567 rupees went missing']) {
      expect(await warningTypes(text), text).toEqual([]);
    }
  });

  it('warns when the text introduces someone by name', async () => {
    for (const text of ['My name is Priya and I work in accounts', 'Hi, I am Rahul from the night shift', 'this is Anand speaking']) {
      expect(await warningTypes(text), text).toEqual(['NAME']);
    }
  });

  it('does not treat ordinary sentence starts as names', async () => {
    for (const text of ['I am Worried about this', 'This is Not okay', 'I am sure the manager knows', 'this is HR related']) {
      expect(await warningTypes(text), text).toEqual([]);
    }
  });

  it('warns about social media handles and profile links', async () => {
    const texts = [
      'DM me @night_owl.22',
      'see instagram.com/someone.real',
      'my profile https://www.linkedin.com/in/someone-real',
      'reach me on t.me/someone_real',
    ];
    for (const text of texts) {
      expect(await warningTypes(text), text).toEqual(['SOCIAL_MEDIA']);
    }
  });

  it('does not mistake ordinary links for profiles', async () => {
    for (const text of ['Evidence is at https://example.com/evidence', 'Files are on dropbox.com/s/abc']) {
      expect(await warningTypes(text), text).toEqual([]);
    }
  });

  it('warns about long ID-like strings', async () => {
    for (const text of ['My employee number is EMP20341', 'Registration REG/2021/04567', 'Roll no 21BCE1234', 'Aadhaar 1234 5678 9012', 'Account 123456789012']) {
      expect(await warningTypes(text), text).toEqual(['ID_NUMBER']);
    }
  });

  it('does not mistake years, quarters or short codes for ID numbers', async () => {
    for (const text of ['Results for FY2023-24 and Q3-2024', 'Room B12 on floor 3', 'Using the mp3 player and covid19 rules']) {
      expect(await warningTypes(text), text).toEqual([]);
    }
  });

  it('reports each kind of detail once with a short message', async () => {
    const res = await api
      .post('/api/reports/check')
      .send({ description: 'I am Ravi, mail ravi.k@example.com or ravi2@example.com, phone 9876543210' });

    expect(res.body.warnings).toEqual([
      { type: 'EMAIL', message: 'This looks like an email address. Remove it if you want to stay anonymous.' },
      { type: 'PHONE', message: 'This looks like a phone number. Remove it if you want to stay anonymous.' },
      { type: 'NAME', message: 'This looks like it includes a name. Remove it if you want to stay anonymous.' },
    ]);
  });

  it('rejects a missing description or unknown fields', async () => {
    for (const body of [{}, { description: 'fine', name: 'x' }]) {
      const res = await api.post('/api/reports/check').send(body);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});
