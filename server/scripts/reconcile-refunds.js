/**
 * Reconciliation script for manual refund list (Jul 8–18 2026).
 * For each phone + GB pair, finds the matching order item and checks
 * whether a refund was issued, and if so whether the amount was correct.
 *
 * Run: node server/scripts/reconcile-refunds.js
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ── Input data parsed from the attached file ────────────────────────────────
const SECTIONS = [
  {
    label: 'Jul 8–16',
    from: new Date('2026-07-08T00:00:00.000Z'),
    to:   new Date('2026-07-16T23:59:59.999Z'),
    entries: [
      ['0534512754',1],['0552659435',1],['0559288472',2],['0535585967',1],
      ['0540877664',1],['0534512754',2],['0598807340',2],['0552619026',2],
      ['0592874876',1],['0591878866',2],['0596722230',1],['0509744829',2],
      ['0540877664',1],['0556213614',2],['0591878866',2],['0548295675',5],
      ['0598201767',1],['0536077442',4],['0537183136',8],['0554659410',1],
      ['0504975840',1],['0530047732',4],['0547513410',1],['0595938064',1],
      ['0592854944',1],['0595517013',1],['0538659128',1],['0553986469',5],
      ['0247101605',2],['0539367420',4],['0597100817',4],['0553234308',1],
      ['0553157086',2],['0554665569',1],['0533723654',1],['0241881438',1],
      ['0593273230',4],['0593858421',1],['0559534518',1],['0597349884',1],
      ['0558469339',2],['0553861645',5],['0241472148',8],['0598069837',2],
      ['0553757907',2],['0552808719',2],['0539309232',1],['0536795251',1],
      ['0552496331',10],['0256328381',5],['0596055264',2],['0538909163',1],
      ['0552659435',1],['0532463495',2],['0558568778',1],['0599487929',2],
      ['0595386671',25],['0531396080',1],['0545114730',2],['0594279123',1],
      ['0556574701',2],['0246953333',6],['0555273981',3],['0532335994',10],
      ['0594665164',2],['0246094151',1],['0554325951',2],['0540877664',1],
      ['0552619026',2],['0592874876',1],['0558085145',10],['0537708232',1],
      ['0555603270',1],['0596722230',1],['0598737653',1],['0597271198',1],
      ['0543153219',1],['0591513723',3],['0257824503',1],['0536279787',4],
      ['0598795424',1],['0596362145',10],['0559288472',2],['0539956818',1],
      ['0559647107',1],['0553001400',1],['0534512754',1],['0534588890',1],
      ['0558272974',1],['0551992142',6],['0542046781',2],['0593912155',10],
      ['0554801799',3],['0557578527',1],['0548657508',5],['0535859740',50],
      ['0534194465',2],['0554028591',2],['0591171623',2],['0542650735',1],
      ['0558636095',2],['0556213614',5],['0592279393',2],['0594559409',10],
      ['0554773306',3],['0595065409',1],['0559459908',2],['0557438163',3],
      ['0596417771',5],['0548854484',5],['0552361549',1],['0241028099',2],
      ['0243648225',2],['0536771827',5],['0244133276',2],['0556900883',3],
      ['0535585967',2],['0244674526',10],['0599522041',1],['0249811833',4],
      ['0559108183',2],['0592631251',2],['0555256386',1],['0536331442',2],
      ['0548540988',1],['0247498994',1],['0531439652',3],['0243020785',5],
      ['0595851301',2],['0533346358',1],['0544839498',3],['0257992663',3],
      ['0556682192',2],['0556133989',1],['0591820117',1],['0547240985',5],
      ['0592266685',5],['0597148110',10],['0552174251',25],['0550028026',1],
      ['0592768181',10],['0594851485',1],['0558191818',4],['0552792596',6],
      ['0598235251',3],['0541837062',1],['0558302388',10],['0599302651',8],
      ['0557188731',1],['0544779079',2],['0557404818',2],['0552777182',3],
      ['0544232688',5],['0549916194',1],['0553941077',1],['0539423902',2],
      ['0593258247',6],['0557557425',2],['0555387193',10],['0559297987',2],
      ['0244925882',4],['0594423837',2],['0550886455',4],['0555885073',1],
      ['0593277018',1],['0598201767',1],['0559645333',1],['0244779727',1],
      ['0557285174',1],['0559974420',8],['0559073797',10],['0540955410',25],
      ['0507971379',5],['0592496643',3],['0591139594',2],['0556257569',3],
      ['0542267822',2],['0555280400',1],['0559561314',1],['0595512374',1],
      ['0543722314',1],['0554244802',1],['0598807340',3],['0594398082',3],
      ['0554645377',3],['0548295675',5],['0591878866',3],['0532606093',1],
      ['0509744829',2],['0598037711',10],['0540686118',2],['0558071406',1],
      ['0591728341',10],['0598034518',1],['0598151200',1],['0542794332',10],
      ['0535501223',1],['0596549366',1],['0594481317',2],['0592009222',2],
      ['0547346638',4],['0545898982',4],['0591066246',2],['0246213226',2],
      ['0256656521',2],['0553010439',2],['0547511447',5],['0593258643',5],
      ['0599507557',2],['0241143331',1],['0552426103',1],['0537263244',5],
      ['0595679909',5],['0555904954',2],['0257809366',6],['0243534814',2],
      ['0597119603',1],['0542280527',4],['0558241662',4],['0597946477',3],
      ['0550527869',3],['0595537283',2],['0592067822',1],
    ]
  },
  {
    label: 'Jul 17',
    from: new Date('2026-07-17T00:00:00.000Z'),
    to:   new Date('2026-07-17T23:59:59.999Z'),
    entries: [
      ['0597353350',2],['0558429917',1],['0532925474',5],['0549536637',1],
      ['0552152300',1],['0550386539',2],['0555480630',1],['0535506290',1],
      ['0596086596',2],['0598440240',2],['0598435823',5],['0535761466',2],
      ['0593858421',1],['0552210433',1],['0538909163',1],['0558568778',1],
      ['0558272974',1],['0559645333',1],['0555904954',2],['0540763322',2],
      ['0591859292',1],['0539367420',4],['0554028591',2],['0556900883',3],
      ['0552426103',1],['0543176803',5],['0595346120',1],['0556790242',1],
      ['0543153219',1],['0247101605',2],['0537183136',8],['0241912278',10],
      ['0532950184',1],['0531860215',2],['0538233974',2],['0592013190',4],
      ['0599507557',1],['0533723654',1],['0558166300',10],['0531324184',2],
      ['0597946477',3],['0552034762',2],['0548014118',1],['0594140707',1],
      ['0534376809',2],['0534334606',2],['0533370811',1],['0543316218',5],
      ['0598807340',1],['0533716775',3],['0547513410',1],['0257373350',10],
      ['0240769842',10],['0542241052',1],['0256832387',6],['0593874465',1],
      ['0540744789',15],['0534423675',4],['0531163312',2],['0542877506',10],
      ['0546909643',1],['0543687760',1],['0558120347',4],['0533582703',1],
      ['0556953936',1],['0241143331',1],['0244942514',1],['0597877580',10],
      ['0556540461',4],['0244124330',5],['0557578527',1],['0597353350',2],
      ['0541996805',1],['0557703864',1],['0244944871',1],['0595999861',1],
      ['0599705422',2],['0593780268',1],['0544684934',6],['0257992663',4],
      ['0559884561',10],['0550596579',3],['0541178542',1],['0558636095',4],
      ['0597017733',1],['0543601082',2],['0548526617',2],['0553045290',5],
      ['0248115197',2],['0540893676',6],['0552575644',8],['0555276714',1],
      ['0535031113',1],['0548250560',1],['0556893155',3],['0555273981',1],
    ]
  },
  {
    label: 'Jul 18',
    from: new Date('2026-07-18T00:00:00.000Z'),
    to:   new Date('2026-07-18T23:59:59.999Z'),
    entries: [
      ['0548264041',2],['0545730752',1],['0599772815',10],['0246822378',1],
      ['0535805429',1],['0241959718',3],['0530624998',2],['0549224697',2],
      ['0246810329',1],['0550596579',3],['0558398292',1],['0245881018',2],
      ['0558213605',3],['0532901779',1],['0591786136',20],['0545064633',4],
      ['0592963827',1],['0554213568',1],['0245260945',1],['0553654942',1],
      ['0557820601',2],['0550767592',2],['0556126129',2],['0241399710',2],
      ['0242502498',3],['0531149467',3],['0556158670',5],['0597266141',1],
      ['0554741943',10],['0558439644',2],['0531160265',2],['0598155626',10],
      ['0538233974',2],['0594950779',2],['0545737753',2],['0544332974',3],
      ['0534497849',1],['0244653020',2],['0552280988',1],['0534366711',4],
      ['0597593771',2],['0552575644',8],['0240769842',10],['0541891127',4],
      ['0552512231',1],['0548652779',2],['0554449141',4],['0553469242',1],
      ['0531324184',2],['0598222179',2],['0538150476',2],['0544877032',10],
      ['0596602703',1],['0592559509',1],['0247101605',2],['0256551484',2],
      ['0242872028',5],['0531471459',1],['0551953303',1],['0552361549',1],
      ['0556574701',2],['0556951896',3],['0596055264',2],['0556213614',2],
      ['0591718821',4],['0554116576',2],['0244124330',5],['0552426103',1],
      ['0552106858',1],['0550386539',2],['0257331892',2],['0552210433',1],
      ['0539684889',2],['0240412176',2],['0591556052',1],['0257130376',10],
    ]
  }
];

async function main() {
  console.log('=== Refund Reconciliation Report (Jul 8–18 2026) ===\n');

  // Collect all unique phones across all sections for a bulk pre-fetch
  const allPhones = [...new Set(SECTIONS.flatMap(s => s.entries.map(e => e[0])))];

  // Pre-fetch all order items for these phones in the full date range
  const allItems = await prisma.orderItem.findMany({
    where: {
      recipientPhone: { in: allPhones },
      createdAt: {
        gte: new Date('2026-07-08T00:00:00.000Z'),
        lte: new Date('2026-07-18T23:59:59.999Z')
      }
    },
    include: {
      bundle: { select: { dataAmount: true } },
      orderGroup: {
        select: { id: true, displayId: true, totalAmount: true, walletDeducted: true, userId: true }
      }
    }
  });

  // Pre-fetch all legacy orders for these phones in the full date range
  const allLegacy = await prisma.order.findMany({
    where: {
      recipientPhone: { in: allPhones },
      createdAt: {
        gte: new Date('2026-07-08T00:00:00.000Z'),
        lte: new Date('2026-07-18T23:59:59.999Z')
      }
    },
    include: { bundle: { select: { dataAmount: true } } }
  });

  // Pre-fetch all relevant wallet ledger refund entries
  const allRefs = [
    ...allItems.map(i => `REFUND-${i.reference}`),
    ...allItems.map(i => `BULK-REFUND-${i.orderGroup?.displayId}`),
    ...allItems.map(i => `BULK-REFUND-${i.reference}`),
    ...allLegacy.map(o => `REFUND-${o.reference}`),
    ...allLegacy.map(o => `BULK-REFUND-${o.reference}`),
  ].filter(Boolean);

  const refundEntries = await prisma.walletLedger.findMany({
    where: {
      reference: { in: [...new Set(allRefs)] },
      entryType: 'REFUND'
    }
  });
  const refundByRef = new Map(refundEntries.map(e => [e.reference, e]));

  // ── Totals ────────────────────────────────────────────────────────────────
  let totalEntries     = 0;
  let foundInDB        = 0;
  let refundedOK       = 0;
  let overRefunded     = 0;
  let notRefunded      = 0;
  let notFoundInDB     = 0;
  let totalExpected    = 0;
  let totalActual      = 0;
  let totalOver        = 0;
  let totalMissing     = 0;

  const issueRows = []; // rows with problems

  for (const section of SECTIONS) {
    for (const [phone, gbSize] of section.entries) {
      totalEntries++;

      // Match order items: phone + bundle starts with GB number
      const gbStr = String(gbSize);
      const matchedItems = allItems.filter(i =>
        i.recipientPhone === phone &&
        i.bundle?.dataAmount?.toLowerCase().replace(/\s/g,'').startsWith(gbStr + 'gb') &&
        i.createdAt >= section.from &&
        i.createdAt <= section.to
      );

      const matchedLegacy = allLegacy.filter(o =>
        o.recipientPhone === phone &&
        o.bundle?.dataAmount?.toLowerCase().replace(/\s/g,'').startsWith(gbStr + 'gb') &&
        o.createdAt >= section.from &&
        o.createdAt <= section.to
      );

      if (matchedItems.length === 0 && matchedLegacy.length === 0) {
        notFoundInDB++;
        issueRows.push({ section: section.label, phone, gb: gbSize, status: 'NOT_FOUND', note: 'No order item in DB for this phone+GB+date' });
        continue;
      }

      foundInDB++;

      // Check each matched item for refund
      for (const item of matchedItems) {
        const correctAmount = item.totalPrice || 0;
        totalExpected += correctAmount;

        // Check item-level refund (new format)
        const itemRefund   = refundByRef.get(`REFUND-${item.reference}`)
                          || refundByRef.get(`BULK-REFUND-${item.reference}`);
        // Check group-level refund (old buggy format)
        const groupRefund  = refundByRef.get(`BULK-REFUND-${item.orderGroup?.displayId}`);

        const actualRefund = itemRefund || groupRefund;
        const actualAmount = actualRefund ? Math.abs(actualRefund.amount) : 0;
        totalActual += actualAmount;

        if (!actualRefund) {
          notRefunded++;
          totalMissing += correctAmount;
          issueRows.push({
            section: section.label, phone, gb: gbSize,
            status: 'NOT_REFUNDED',
            note: `Order ${item.reference} (GH₵${correctAmount.toFixed(2)}) — no refund found in ledger`
          });
        } else if (actualAmount > correctAmount + 0.01) {
          overRefunded++;
          totalOver += actualAmount - correctAmount;
          issueRows.push({
            section: section.label, phone, gb: gbSize,
            status: 'OVER_REFUNDED',
            note: `Order ${item.reference}: refunded GH₵${actualAmount.toFixed(2)}, correct was GH₵${correctAmount.toFixed(2)} (excess GH₵${(actualAmount-correctAmount).toFixed(2)})`
          });
        } else {
          refundedOK++;
        }
      }

      for (const order of matchedLegacy) {
        const correctAmount = order.totalPrice || 0;
        totalExpected += correctAmount;
        const legRefund = refundByRef.get(`REFUND-${order.reference}`)
                       || refundByRef.get(`BULK-REFUND-${order.reference}`);
        const actualAmount = legRefund ? Math.abs(legRefund.amount) : 0;
        totalActual += actualAmount;

        if (!legRefund) {
          notRefunded++;
          totalMissing += correctAmount;
          issueRows.push({
            section: section.label, phone, gb: gbSize,
            status: 'NOT_REFUNDED',
            note: `Legacy order ${order.reference} (GH₵${correctAmount.toFixed(2)}) — no refund found`
          });
        } else if (actualAmount > correctAmount + 0.01) {
          overRefunded++;
          totalOver += actualAmount - correctAmount;
          issueRows.push({
            section: section.label, phone, gb: gbSize,
            status: 'OVER_REFUNDED',
            note: `Legacy ${order.reference}: refunded GH₵${actualAmount.toFixed(2)}, correct was GH₵${correctAmount.toFixed(2)} (excess GH₵${(actualAmount-correctAmount).toFixed(2)})`
          });
        } else {
          refundedOK++;
        }
      }
    }
  }

  // ── Print issue rows ───────────────────────────────────────────────────────
  if (issueRows.length > 0) {
    console.log('=== ISSUES FOUND ===\n');
    const overRows    = issueRows.filter(r => r.status === 'OVER_REFUNDED');
    const missedRows  = issueRows.filter(r => r.status === 'NOT_REFUNDED');
    const noDBRows    = issueRows.filter(r => r.status === 'NOT_FOUND');

    if (overRows.length) {
      console.log(`-- OVER-REFUNDED (${overRows.length}) --`);
      overRows.forEach(r => console.log(`  [${r.section}] ${r.phone} ${r.gb}GB  →  ${r.note}`));
      console.log();
    }
    if (missedRows.length) {
      console.log(`-- NOT REFUNDED - order found but no refund ledger entry (${missedRows.length}) --`);
      missedRows.forEach(r => console.log(`  [${r.section}] ${r.phone} ${r.gb}GB  →  ${r.note}`));
      console.log();
    }
    if (noDBRows.length) {
      console.log(`-- NOT FOUND IN DB - no order item for this phone+GB+date (${noDBRows.length}) --`);
      noDBRows.forEach(r => console.log(`  [${r.section}] ${r.phone} ${r.gb}GB`));
      console.log();
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('=== SUMMARY ===');
  console.log(`Total entries in your list  : ${totalEntries}`);
  console.log(`  Orders found in DB        : ${foundInDB}`);
  console.log(`  NOT found in DB           : ${notFoundInDB}`);
  console.log(`  Refunded correctly        : ${refundedOK}`);
  console.log(`  Over-refunded (bug)       : ${overRefunded}  (excess GH₵${totalOver.toFixed(2)})`);
  console.log(`  Not refunded at all       : ${notRefunded}   (missing GH₵${totalMissing.toFixed(2)})`);
  console.log();
  console.log(`Total correct refund value  : GH₵${totalExpected.toFixed(2)}`);
  console.log(`Total actually refunded     : GH₵${totalActual.toFixed(2)}`);
  console.log(`Net discrepancy             : GH₵${(totalActual - totalExpected).toFixed(2)}`);
}

main()
  .catch(err => { console.error('Script failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
