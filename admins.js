const admins = new Set();

module.exports = {
    isAdmin(id) {
        return admins.has(Number(id));
    },

    addAdmin(id) {
        admins.add(Number(id));
    },

    removeAdmin(id) {
        admins.delete(Number(id));
    },

    getAdmins() {
        return Array.from(admins);
    }
};