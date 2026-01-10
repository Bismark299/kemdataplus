// Script to create transaction record for Paystack payment that credited wallet but didn't create transaction
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function fixPaystackTransaction() {
  // The reference from your payment
  const reference = 'KDP_bf1f69f7_1768029790507';
  const amount = 1.00; // GHS - update this with your actual amount
  
  try {
    // Find the pending payment
    const pendingPayment = await prisma.pendingPayment.findUnique({
      where: { reference }
    });
    
    console.log('PendingPayment:', pendingPayment);
    
    if (!pendingPayment) {
      console.log('No pending payment found with this reference');
      return;
    }
    
    // Check if transaction already exists
    const existingTxn = await prisma.transaction.findFirst({
      where: {
        OR: [
          { reference },
          { reference: `PS_${reference}` }
        ]
      }
    });
    
    if (existingTxn) {
      console.log('Transaction already exists:', existingTxn);
      return;
    }
    
    // Get user's wallet
    const wallet = await prisma.wallet.findUnique({
      where: { userId: pendingPayment.userId }
    });
    
    if (!wallet) {
      console.log('Wallet not found for user:', pendingPayment.userId);
      return;
    }
    
    console.log('Current wallet balance:', wallet.balance);
    
    // Create transaction record
    const txn = await prisma.transaction.create({
      data: {
        walletId: wallet.id,
        type: 'DEPOSIT',
        amount: pendingPayment.amount,
        status: 'COMPLETED',
        reference: `PS_${reference}`,
        description: 'Paystack deposit via mobile_money (manual fix)'
      }
    });
    
    console.log('Created transaction:', txn);
    
    // Update pending payment status if needed
    if (pendingPayment.status !== 'COMPLETED') {
      await prisma.pendingPayment.update({
        where: { reference },
        data: { status: 'COMPLETED', completedAt: new Date() }
      });
      console.log('Updated pending payment to COMPLETED');
    }
    
    console.log('✅ Done! Check your transaction history now.');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

fixPaystackTransaction();
