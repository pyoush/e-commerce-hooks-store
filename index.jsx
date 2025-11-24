import React, { useState, useEffect, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, collection, onSnapshot, setDoc, updateDoc, deleteDoc, runTransaction, query, where } from 'firebase/firestore';

// --- Firestore/Firebase Global Variable Setup ---
// These variables are provided by the canvas environment.
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// Helper function for exponential backoff (retry logic)
const withRetry = async (fn, maxRetries = 5) => {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;
      const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

/**
 * Main application component using React and Firebase.
 */
const App = () => {
  const [db, setDb] = useState(null);
  const [auth, setAuth] = useState(null);
  const [userId, setUserId] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);

  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('dashboard'); // 'dashboard', 'products', 'orders'

  // Form states for adding/editing a product
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [currentProduct, setCurrentProduct] = useState(null);
  const [productName, setProductName] = useState('');
  const [productStock, setProductStock] = useState(0);
  const [productPrice, setProductPrice] = useState(0);

  // --- 1. Firebase Initialization and Authentication ---
  useEffect(() => {
    if (!firebaseConfig || !Object.keys(firebaseConfig).length) {
        console.error("Firebase config is missing or empty. Cannot initialize app.");
        setLoading(false);
        return;
    }

    const app = initializeApp(firebaseConfig);
    const firestore = getFirestore(app);
    const firebaseAuth = getAuth(app);
    setDb(firestore);
    setAuth(firebaseAuth);

    const unsubscribe = onAuthStateChanged(firebaseAuth, async (user) => {
      if (user) {
        setUserId(user.uid);
      } else {
        // Sign in anonymously if initialAuthToken is not available or failed
        if (!initialAuthToken) {
          try {
            const anonymousUser = await signInAnonymously(firebaseAuth);
            setUserId(anonymousUser.user.uid);
          } catch (error) {
            console.error("Anonymous sign in failed:", error);
          }
        }
      }
      setIsAuthReady(true);
    });

    // Use custom token if available (runs once on load)
    const authenticate = async () => {
        try {
            if (initialAuthToken) {
                await signInWithCustomToken(firebaseAuth, initialAuthToken);
            } else {
                // If no custom token, onAuthStateChanged handles anonymous sign-in
            }
        } catch (error) {
            console.error("Custom token sign in failed:", error);
            // Fallback to anonymous sign-in if token sign-in fails
            if (!firebaseAuth.currentUser) {
              await signInAnonymously(firebaseAuth);
            }
        }
    };

    authenticate();

    return () => unsubscribe();
  }, []);

  // --- 2. Real-time Data Fetching (Products and Orders) ---
  useEffect(() => {
    if (!isAuthReady || !db || !userId) return;

    const productsCollectionRef = collection(db, `artifacts/${appId}/users/${userId}/products`);
    const ordersCollectionRef = collection(db, `artifacts/${appId}/users/${userId}/orders`);

    // Listen for Product changes
    const unsubscribeProducts = onSnapshot(productsCollectionRef, (snapshot) => {
      const productList = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setProducts(productList);
    }, (error) => console.error("Error fetching products:", error));

    // Listen for Order changes
    const unsubscribeOrders = onSnapshot(ordersCollectionRef, (snapshot) => {
      const orderList = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setOrders(orderList);
    }, (error) => console.error("Error fetching orders:", error));

    setLoading(false);

    return () => {
      unsubscribeProducts();
      unsubscribeOrders();
    };
  }, [db, userId, isAuthReady]);

  // --- 3. Product CRUD Operations ---

  const handleOpenModal = (product = null) => {
    if (product) {
      setIsEditing(true);
      setCurrentProduct(product);
      setProductName(product.name);
      setProductStock(product.stock);
      setProductPrice(product.price);
    } else {
      setIsEditing(false);
      setCurrentProduct(null);
      setProductName('');
      setProductStock(0);
      setProductPrice(0);
    }
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
  };

  const saveProduct = useCallback(async (e) => {
    e.preventDefault();
    if (!db || !userId || !productName) return;

    const productData = {
      name: productName,
      stock: parseInt(productStock, 10) || 0,
      price: parseFloat(productPrice) || 0.00,
      updatedAt: new Date().toISOString(),
    };

    const productsCollectionRef = collection(db, `artifacts/${appId}/users/${userId}/products`);

    try {
      await withRetry(async () => {
        if (isEditing && currentProduct?.id) {
          const productDocRef = doc(productsCollectionRef, currentProduct.id);
          await updateDoc(productDocRef, productData);
        } else {
          await setDoc(doc(productsCollectionRef), { ...productData, createdAt: new Date().toISOString() });
        }
      });
      handleCloseModal();
    } catch (error) {
      console.error("Error saving product:", error);
    }
  }, [db, userId, productName, productStock, productPrice, isEditing, currentProduct]);

  const deleteProduct = useCallback(async (productId) => {
    if (!db || !userId || !window.confirm("Are you sure you want to delete this product?")) return;

    const productsCollectionRef = collection(db, `artifacts/${appId}/users/${userId}/products`);
    const productDocRef = doc(productsCollectionRef, productId);

    try {
      await withRetry(async () => {
        await deleteDoc(productDocRef);
      });
    } catch (error) {
      console.error("Error deleting product:", error);
    }
  }, [db, userId]);

  // --- 4. Order Simulation/Fulfillment ---

  const simulateOrder = useCallback(async () => {
    if (!db || !userId || products.length === 0) return;

    const selectedProduct = products[Math.floor(Math.random() * products.length)];
    const quantity = Math.floor(Math.random() * 5) + 1; // 1 to 5 units

    const productDocRef = doc(db, `artifacts/${appId}/users/${userId}/products`, selectedProduct.id);
    const ordersCollectionRef = collection(db, `artifacts/${appId}/users/${userId}/orders`);

    try {
      await withRetry(async () => {
        await runTransaction(db, async (transaction) => {
          const productDoc = await transaction.get(productDocRef);
          if (!productDoc.exists()) {
            throw "Product does not exist!";
          }

          const newStock = productDoc.data().stock - quantity;

          if (newStock < 0) {
            // This is a safety check; normally UI prevents this
            throw "Insufficient stock for this order!";
          }

          // 1. Decrease product stock
          transaction.update(productDocRef, { stock: newStock });

          // 2. Create the new order
          const newOrder = {
            productId: selectedProduct.id,
            productName: selectedProduct.name,
            quantity: quantity,
            totalPrice: quantity * selectedProduct.price,
            status: 'Pending',
            orderedAt: new Date().toISOString(),
          };
          transaction.set(doc(ordersCollectionRef), newOrder);
        });
      });
    } catch (error) {
      console.error("Transaction failed (Simulate Order):", error);
      // Display message box if stock was insufficient
      if (typeof error === 'string' && error.includes("Insufficient stock")) {
          // NOTE: Changed from alert() to console error for environment compliance.
          console.error("Order simulation failed: Insufficient stock.");
      }
    }
  }, [db, userId, products]);

  const fulfillOrder = useCallback(async (orderId) => {
    if (!db || !userId) return;

    const orderDocRef = doc(db, `artifacts/${appId}/users/${userId}/orders`, orderId);

    try {
      await withRetry(async () => {
        await updateDoc(orderDocRef, { status: 'Fulfilled', fulfilledAt: new Date().toISOString() });
      });
    } catch (error) {
      console.error("Error fulfilling order:", error);
    }
  }, [db, userId]);

  // --- 5. Data Calculations for Dashboard ---
  const totalRevenue = orders
    .filter(o => o.status === 'Fulfilled')
    .reduce((sum, order) => sum + (order.totalPrice || 0), 0);

  const totalStockValue = products.reduce((sum, p) => sum + (p.stock * p.price), 0);

  const pendingOrders = orders.filter(o => o.status === 'Pending').length;

  const lowStockProducts = products.filter(p => p.stock <= 5).length;

  // --- 6. Helper Components ---

  const DashboardView = () => (
    <div className="p-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
      {/* Stat Card 1: Total Revenue */}
      <div className="bg-white p-6 rounded-xl shadow-lg border-t-4 border-green-500 hover:shadow-xl transition duration-300">
        <div className="flex items-center">
          <svg className="w-8 h-8 text-green-500 mr-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0zM12 15V9" /></svg>
          <div>
            <p className="text-sm font-medium text-gray-500">Total Revenue</p>
            <p className="text-3xl font-bold text-gray-900">${totalRevenue.toFixed(2)}</p>
          </div>
        </div>
      </div>

      {/* Stat Card 2: Pending Orders */}
      <div className="bg-white p-6 rounded-xl shadow-lg border-t-4 border-blue-500 hover:shadow-xl transition duration-300">
        <div className="flex items-center">
          <svg className="w-8 h-8 text-blue-500 mr-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" /></svg>
          <div>
            <p className="text-sm font-medium text-gray-500">Pending Orders</p>
            <p className="text-3xl font-bold text-gray-900">{pendingOrders}</p>
          </div>
        </div>
      </div>

      {/* Stat Card 3: Products in Stock */}
      <div className="bg-white p-6 rounded-xl shadow-lg border-t-4 border-purple-500 hover:shadow-xl transition duration-300">
        <div className="flex items-center">
          <svg className="w-8 h-8 text-purple-500 mr-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 7v10l9 4 9-4V7M4 7l9 4 9-4M4 7V3a1 1 0 011-1h14a1 1 0 011 1v4M12 17v4m-4-2h8" /></svg>
          <div>
            <p className="text-sm font-medium text-gray-500">Total Stock Value</p>
            <p className="text-3xl font-bold text-gray-900">${totalStockValue.toFixed(2)}</p>
          </div>
        </div>
      </div>

      {/* Stat Card 4: Low Stock Alert */}
      <div className="bg-white p-6 rounded-xl shadow-lg border-t-4 border-red-500 hover:shadow-xl transition duration-300">
        <div className="flex items-center">
          <svg className="w-8 h-8 text-red-500 mr-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.372 17c-.77 1.333.192 3 1.732 3z" /></svg>
          <div>
            <p className="text-sm font-medium text-gray-500">Low Stock Alert</p>
            <p className="text-3xl font-bold text-red-600">{lowStockProducts} item(s) &lt;= 5</p>
          </div>
        </div>
      </div>

      <div className="md:col-span-2 xl:col-span-4 mt-8">
        <h3 className="text-2xl font-semibold text-gray-800 mb-4 border-b pb-2">Recent Orders</h3>
        <OrderList isDashboard={true} />
      </div>

      <div className="md:col-span-2 xl:col-span-4 mt-4">
        <button
          onClick={simulateOrder}
          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 px-6 rounded-xl transition duration-200 shadow-md transform hover:scale-[1.01]"
          disabled={products.length === 0}
        >
          {products.length === 0 ? 'Add Products to Simulate Orders' : 'Simulate New Customer Order'}
        </button>
      </div>
    </div>
  );

  const ProductListView = () => (
    <div className="p-4">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-3xl font-bold text-gray-800">Product Inventory</h2>
        <button
          onClick={() => handleOpenModal()}
          className="bg-green-500 hover:bg-green-600 text-white font-semibold py-2 px-4 rounded-lg shadow-md transition duration-200 flex items-center"
        >
          <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
          Add Product
        </button>
      </div>
      <div className="overflow-x-auto bg-white rounded-xl shadow-lg">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Price</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Stock</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Updated At</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {products.length === 0 ? (
              <tr>
                <td colSpan="5" className="px-6 py-4 text-center text-gray-500">No products found. Add your first product!</td>
              </tr>
            ) : (
              products.map((product) => (
                <tr key={product.id} className={product.stock <= 5 ? 'bg-red-50 hover:bg-red-100' : 'hover:bg-gray-50'}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{product.name}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${(product.price || 0).toFixed(2)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold" style={{ color: product.stock <= 5 ? 'red' : 'green' }}>
                    {product.stock} units
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {new Date(product.updatedAt).toLocaleTimeString()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button
                      onClick={() => handleOpenModal(product)}
                      className="text-indigo-600 hover:text-indigo-900 mr-4 p-1 rounded-full hover:bg-indigo-50"
                      title="Edit Product"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                    </button>
                    <button
                      onClick={() => deleteProduct(product.id)}
                      className="text-red-600 hover:text-red-900 p-1 rounded-full hover:bg-red-50"
                      title="Delete Product"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  const OrderList = ({ isDashboard = false }) => {
    const ordersToShow = isDashboard ? orders.slice(0, 5) : orders;
    const title = isDashboard ? 'Recent Orders' : 'All Orders';

    return (
      <div className="p-4 pt-0">
        <div className={`flex justify-between items-center mb-6 ${isDashboard ? 'hidden' : ''}`}>
          <h2 className="text-3xl font-bold text-gray-800">{title}</h2>
        </div>
        <div className="overflow-x-auto bg-white rounded-xl shadow-lg">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Order ID</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Product</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Qty</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Total</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {orders.length === 0 ? (
                <tr>
                  <td colSpan="6" className="px-6 py-4 text-center text-gray-500">No orders placed yet. Simulate an order!</td>
                </tr>
              ) : (
                ordersToShow.map((order) => (
                  <tr key={order.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-900 truncate max-w-[100px]">{order.id}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{order.productName}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{order.quantity}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-gray-900">${(order.totalPrice || 0).toFixed(2)}</td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`px-3 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${
                        order.status === 'Fulfilled' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
                      }`}>
                        {order.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      {order.status === 'Pending' && (
                        <button
                          onClick={() => fulfillOrder(order.id)}
                          className="text-blue-600 hover:text-blue-900 p-1 rounded-full hover:bg-blue-50"
                          title="Fulfill Order"
                        >
                           <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" /></svg>
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const Modal = () => {
    if (!isModalOpen) return null;

    return (
      <div className="fixed inset-0 bg-gray-600 bg-opacity-75 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6">
          <h3 className="text-2xl font-bold text-gray-800 mb-6 border-b pb-2">
            {isEditing ? 'Edit Product' : 'Add New Product'}
          </h3>
          <form onSubmit={saveProduct}>
            <div className="mb-4">
              <label htmlFor="name" className="block text-sm font-medium text-gray-700">Product Name</label>
              <input
                id="name"
                type="text"
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                required
                className="mt-1 block w-full border border-gray-300 rounded-lg shadow-sm p-3 focus:ring-indigo-500 focus:border-indigo-500"
                placeholder="e.g., Wireless Headset"
              />
            </div>
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div>
                <label htmlFor="price" className="block text-sm font-medium text-gray-700">Price ($)</label>
                <input
                  id="price"
                  type="number"
                  step="0.01"
                  min="0"
                  value={productPrice}
                  onChange={(e) => setProductPrice(e.target.value)}
                  required
                  className="mt-1 block w-full border border-gray-300 rounded-lg shadow-sm p-3 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
              <div>
                <label htmlFor="stock" className="block text-sm font-medium text-gray-700">Stock (Units)</label>
                <input
                  id="stock"
                  type="number"
                  min="0"
                  value={productStock}
                  onChange={(e) => setProductStock(e.target.value)}
                  required
                  className="mt-1 block w-full border border-gray-300 rounded-lg shadow-sm p-3 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
            </div>

            <div className="flex justify-end space-x-3">
              <button
                type="button"
                onClick={handleCloseModal}
                className="px-4 py-2 bg-gray-200 text-gray-800 font-semibold rounded-lg hover:bg-gray-300 transition duration-150"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-700 transition duration-150 shadow-md"
              >
                {isEditing ? 'Update Product' : 'Add Product'}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  };

  // --- 7. Main Render Function ---

  if (loading || !isAuthReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="flex items-center space-x-2 text-indigo-600">
          <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25"></circle><path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" className="opacity-75"></path></svg>
          <span>Loading Application...</span>
        </div>
      </div>
    );
  }

  const renderView = () => {
    switch (view) {
      case 'products':
        return <ProductListView />;
      case 'orders':
        return <OrderList isDashboard={false} />;
      case 'dashboard':
      default:
        return <DashboardView />;
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 flex font-sans">
      <Modal />
      {/* Sidebar Navigation */}
      <nav className="w-56 bg-white shadow-lg p-4 flex flex-col justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-indigo-600 mb-8 border-b pb-2">E-Comm V2</h1>
          <ul className="space-y-2">
            {[
              { id: 'dashboard', name: 'Dashboard', icon: (
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>
              )},
              { id: 'products', name: 'Products', icon: (
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" /></svg>
              )},
              { id: 'orders', name: 'Orders', icon: (
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" /></svg>
              )},
            ].map(item => (
              <li key={item.id}>
                <button
                  onClick={() => setView(item.id)}
                  className={`w-full flex items-center space-x-3 p-3 rounded-lg transition duration-150 ${
                    view === item.id
                      ? 'bg-indigo-100 text-indigo-700 font-bold shadow-sm'
                      : 'text-gray-600 hover:bg-gray-50 hover:text-indigo-600'
                  }`}
                >
                  {item.icon}
                  <span>{item.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* User Footer */}
        <div className="border-t pt-4 text-xs text-gray-500">
          <p className="font-semibold mb-1">User ID (Canvas Artifact Scope):</p>
          <p className="break-all font-mono bg-gray-100 p-2 rounded-lg text-sm">{userId}</p>
        </div>
      </nav>

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto">
        {renderView()}
      </main>
    </div>
  );
};

export default App;