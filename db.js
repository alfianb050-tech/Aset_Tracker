const SUPABASE_URL = 'https://cxryyztccnyhszkeetmx.supabase.co'; // Ganti pake URL lo
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN4cnl5enRjY255aHN6a2VldG14Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4NzM5ODgsImV4cCI6MjA5MjQ0OTk4OH0.dkHgRdG9OlTyExJoHtNLrm9F3Z-4fwIGgIbEh_yQt4E'; // Ganti pake Anon Key lo

// 1. Inisialisasi Client
window._supabase = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * --- AUTHENTICATION FUNCTIONS ---
 */

// Login: Menggunakan email & password
window.loginUser = async function(email, password) {
    try {
        const { data, error } = await _supabase.auth.signInWithPassword({
            email: email,
            password: password,
        });
        if (error) throw error;
        return data;
    } catch (err) {
        console.error('Login Error:', err.message);
        throw err;
    }
};

// Logout: Bersihkan session dan balik ke login
window.logoutUser = async function() {
    try {
        const { error } = await _supabase.auth.signOut();
        if (error) throw error;
        window.location.href = 'login.html';
    } catch (err) {
        console.error('Logout Error:', err.message);
    }
};

// Cek User: Mendapatkan info user yang sedang aktif
window.getCurrentUser = async function() {
    const { data: { user } } = await _supabase.auth.getUser();
    return user;
};

/**
 * --- DATA FUNCTIONS (TRANSACTIONS) ---
 */

// Ambil Data: HANYA data milik user yang sedang login
window.getTransactions = async function() {
    try {
        const user = await window.getCurrentUser();
        if (!user) return [];

        const { data, error } = await _supabase
            .from('transactions')
            .select('*')
            .eq('user_id', user.id) // Security Filter
            .order('id', { ascending: false });

        if (error) throw error;
        return data;
    } catch (err) {
        console.error('Error tarik data:', err.message);
        return [];
    }
};

// Simpan Data: Otomatis nambahin user_id dari session aktif
window.saveTransactionToCloud = async function(newTx) {
    try {
        const user = await window.getCurrentUser();
        if (!user) throw new Error("Akses ditolak, silahkan login ulang.");

        // Gabungkan data input dengan ID user
        const txWithUser = { ...newTx, user_id: user.id };

        const { data, error } = await _supabase
            .from('transactions')
            .insert([txWithUser])
            .select();

        if (error) throw error;
        return data;
    } catch (err) {
        console.error('Gagal simpan ke Cloud:', err.message);
        return null;
    }
};

// Hapus Data: Pastikan ID transaksi DAN user_id cocok (Double Lock)
window.deleteTransactionFromCloud = async function(id) {
    try {
        const user = await window.getCurrentUser();
        if (!user) return false;

        const { error } = await _supabase
            .from('transactions')
            .delete()
            .eq('id', id)
            .eq('user_id', user.id);

        if (error) throw error;
        return true;
    } catch (err) {
        console.error('Gagal hapus data:', err.message);
        return false;
    }
};